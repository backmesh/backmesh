import {
  InvalidProxyRequest,
  assertEndUserAnalyticsSummary,
  modelCostsPerMillion,
  ProxyExchange,
  ProxyRequest,
  ProxyResponse,
  LLMUsage,
  EndUserAnalyticsSummary,
} from "./repos/models";
import KV from "./repos/kv";

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

	// adds a new proxy exchange to the end user's summary and updates the end user summary by generating a new key
	static async update(
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

	// returns summaries for all end users of this backmesh proxy
	// which implies just getting the keys, parsing them and adding them to the summaries
	static async getAll(
		env: Env,
		backmeshUid: string,
		proxyId: string,
	): Promise<EndUserAnalyticsSummary[]> {
		const prefix = this.getListKey(backmeshUid, proxyId);
		const keys = await KV.listKeys(env.BACKMESH_KV, prefix);
		const summaries: { [endUserId: string]: EndUserAnalyticsSummary } = {};

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

			assertEndUserAnalyticsSummary(summary);
		}
		return Object.values(summaries);
	}

	static getListKey(backmeshUid: string, proxyId: string) {
		return `reqs/${backmeshUid}/${proxyId}/`;
	}

	// this is best effort so it fallsback to 0 cost
	// does not support caching, fine tuned models, image and audio models
	static estimateCost(usage: LLMUsage): number {
		const model = usage.model.toLowerCase();
		const costs = modelCostsPerMillion[model] || { input: 0, output: 0 };

		let cost = 0;

		if (costs.threshold && usage.inputTokens > costs.threshold) {
			cost +=
				(usage.inputTokens * (costs.postThresholdInput || costs.input)) / 1_000_000;
			if (usage.outputTokens) {
				cost +=
					(usage.outputTokens * (costs.postThresholdOutput || costs.output || 0)) /
					1_000_000;
			}
		} else {
			cost += (usage.inputTokens * costs.input) / 1_000_000;
			if (usage.outputTokens) {
				cost += (usage.outputTokens * (costs.output || 0)) / 1_000_000;
			}
		}

		return cost;
	}
}