import {
  InvalidProxyRequest,
  assertEndUserAnalytics,
  ProxyExchange,
  ProxyRequest,
  ProxyResponse,
  LLMUsage,
  EndUserAnalytics,
	MODEL_PRICES,
} from "./repos/models";
import KV from "./repos/kv";


/**
 * A class representing a proxy exchange with of it summary stored in the key itself.
 *
 * @property ts - The timestamp of the proxy exchange.
 * @property status - The status code of the proxy response.
 * @property timing - The timing of the proxy exchange.
 * @property model - The model used in the proxied request.
 * @property cost - The cost of the proxied request.
 */
export class ProxyExchangeSummary {
	ts: number;
	status: number;
	timing: number;
	model?: string;
	cost?: number;

	constructor({
		ts,
		status,
		timing,
		model,
		cost,
	}: {
		ts: number;
		status: number;
		timing: number;
		model?: string;
		cost?: number;
	}) {
		this.model = model;
		this.timing = timing;
		this.ts = ts;
		this.cost = cost;
		this.status = status;
	}

	// get summary from key
	static fromKey(key: string): {
		kSumm: ProxyExchangeSummary;
		endUserId: string;
	} {
		const [proxyExchangesKey, status, timing, model, cost] = key.split('|');
		/*
		[
			'reqs/jhsjxdmMVDOFWmK7rfngn1C2cY93/66L9auzfWmt4JLvVaSA6/hwTJkh1Z1GQSiKG7qbMyhtZT5WY2/1740260343109',
			'200',
			'588',
			'@cf/meta/llama-3.2-1b-instruct',
			'0.0000023880000000000003'
		]
		*/
		const keyParts = proxyExchangesKey.split('/')
		/*
		[
			'reqs',
			'jhsjxdmMVDOFWmK7rfngn1C2cY93',
			'66L9auzfWmt4JLvVaSA6',
			'hwTJkh1Z1GQSiKG7qbMyhtZT5WY2',
			'1740260343109',
		]
		*/
		const endUserId = keyParts[keyParts.length - 2]
		const ts = keyParts[keyParts.length - 1]
		return {
			endUserId,
			kSumm: new ProxyExchangeSummary({
				model,
				timing: Number(timing),
				ts: Number(ts),
				cost: Number(cost),
				status: Number(status),
			}),
		};
	}

	toKey(backmeshUid: string, proxyId: string, endUserId: string): string {
		let key = `${ProxyExchangeSummary.getListKey(backmeshUid, proxyId)}${endUserId}/${
			this.ts
		}|${this.status}|${this.timing}`;
		return `${key}|${this.model}|${this.cost}`;
	}

  /**
   * Saves a proxy exchange and generates a summary to store in the key itself.
   *
   * @param env - The environment object containing the KV store.
   * @param proxyReq - The proxy request object.
   * @param ts - The timestamp of the proxy exchange.
   * @param timing - The timing of the proxy exchange.
   * @param proxyRes - The proxy response object.
   */
	static async create(
		env: Env,
		proxyReq: ProxyRequest | InvalidProxyRequest,
		ts: number,
		timing: number,
		proxyRes: ProxyResponse,
	): Promise<void> {
		const { backmeshUid, proxyId, endUserId, request } = proxyReq;
		if (!backmeshUid || !proxyId || !endUserId) return;
		const usage = proxyRes.usage;
		const model = usage ? usage.model : undefined;
		const cost = usage ? ProxyExchangeSummary.estimateCost(usage) : undefined;
		const summary = new ProxyExchangeSummary({
			status: proxyRes.response.status,
			ts,
			timing,
			cost,
			model,
		});
		const key = summary.toKey(backmeshUid, proxyId, endUserId);
		await KV.create<ProxyExchange>(env.BACKMESH_KV, key, {
			url: request.url,
			reqHeaders: Array.from(request.headers.entries()),
			reqBody: request.body ? await request.clone().text() : undefined,
			resBody: proxyRes.parsedBody,
			resHeaders: Array.from(proxyRes.response.headers.entries()),
		});
	}

	/**
	 * Aggregates analytics data for all end users of a specific proxy.
	 * Retrieves all proxy exchange keys and extracts usage summaries from the metadata in the key itself.
	 * Groups metrics (requests, errors, costs, timing) by end user.
	 *
	 * @param env - The environment object containing the KV store.
	 * @param backmeshUid - The unique identifier for the backmesh.
	 * @param proxyId - The identifier for the proxy.
	 * @returns An array of EndUserAnalytics objects containing aggregated analytics data.
	 */
	static async analyticsPerUser(
		env: Env,
		backmeshUid: string,
		proxyId: string,
	): Promise<EndUserAnalytics[]> {
		const prefix = this.getListKey(backmeshUid, proxyId);
		const keys = await KV.listKeys(env.BACKMESH_KV, prefix);
		const summaries: { [endUserId: string]: EndUserAnalytics } = {};

		for (const key of keys) {
			const { kSumm, endUserId } = ProxyExchangeSummary.fromKey(key.name);

			if (!summaries[endUserId]) {
				summaries[endUserId] = {
					endUserId,
					reqCount: 0,
					errorCount: 0,
					totalCost: 0,
					totalTiming: 0,
					firstTs: Number(kSumm.ts),
					lastTs: Number(kSumm.ts),
				};
			}

			const summary = summaries[endUserId];
			summary.reqCount += 1;
			summary.errorCount += Number(kSumm.status) >= 400 ? 1 : 0;
			summary.totalCost += kSumm.cost ? Number(kSumm.cost) : 0;
			summary.totalTiming += Number(kSumm.timing);
			summary.firstTs = Math.min(summary.firstTs, Number(kSumm.ts));
			summary.lastTs = Math.max(summary.lastTs, Number(kSumm.ts));

			assertEndUserAnalytics(summary);
		}
		return Object.values(summaries);
	}

	static getListKey(backmeshUid: string, proxyId: string) {
		return `reqs/${backmeshUid}/${proxyId}/`;
	}

  /**
   * Estimates the cost of an LLM usage.
   *
   * @param usage - The LLM usage object containing input and output tokens.
   * @returns The estimated cost of the LLM usage.
   */
	static estimateCost(usage: LLMUsage): number {
		const model = usage.model.toLowerCase();
		// Get model pricing from the new data structure
		const modelPricing = MODEL_PRICES[model];
		// If model not found, return 0 cost
		if (!modelPricing) {
			console.error(`Model ${model} not found in MODEL_PRICES`);
			return 0;
		}
		let cost = 0;
		// Calculate input token cost
		if (modelPricing.input_cost_per_token) {
			cost += usage.inputTokens * modelPricing.input_cost_per_token;
		}
		// Calculate output token cost if available
		if (usage.outputTokens && modelPricing.output_cost_per_token) {
			cost += usage.outputTokens * modelPricing.output_cost_per_token;
		}
		// TODO handle audio tokens
		// if (usage.audioInputTokens && modelPricing.input_cost_per_audio_token) {
		// 	cost += usage.audioInputTokens * modelPricing.input_cost_per_audio_token;
		// }
		// if (usage.audioOutputTokens && modelPricing.output_cost_per_audio_token) {
		// 	cost += usage.audioOutputTokens * modelPricing.output_cost_per_audio_token;
		// }

		// TODO handle batch pricing if available and applicable
		// if (usage.isBatch && modelPricing.input_cost_per_token_batches) {
		// 	// Replace the standard input cost with batch pricing
		// 	cost -= usage.inputTokens * modelPricing.input_cost_per_token;
		// 	cost += usage.inputTokens * modelPricing.input_cost_per_token_batches;
		// 	if (usage.outputTokens && modelPricing.output_cost_per_token_batches) {
		// 		cost -= usage.outputTokens * modelPricing.output_cost_per_token;
		// 		cost += usage.outputTokens * modelPricing.output_cost_per_token_batches;
		// 	}
		// }
		return cost;
	}
}