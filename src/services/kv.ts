import {
	InvalidProxyRequest,
	LLMUsage,
	ProxyRequest,
	ProxyResponse,
} from '../proxy';
import { decrypt, encrypt } from './crypto';
import KV from './repos/kv';

export enum AuthProviderType {
	FIREBASE = 'Firebase',
	SUPABASE = 'Supabase',
}

export enum SchemaVersion {
	V1 = 'V1',
}

export enum RateLimitUnit {
	MINUTE = 'minute',
	HOUR = 'hour',
	DAY = 'day',
	MONTH = 'month',
}

function getRateLimitUnitInSecs(unit: RateLimitUnit): number {
	switch (unit) {
		case RateLimitUnit.MINUTE:
			return 60;
		case RateLimitUnit.HOUR:
			return 3600;
		case RateLimitUnit.DAY:
			return 86400;
		case RateLimitUnit.MONTH:
			return 2592000; // Assuming 30 days in a month
		default:
			throw new Error('Invalid RateLimitUnit');
	}
}

export type ProxyExchange = {
	url: string;
	reqHeaders: [key: string, value: string][];
	reqBody?: string;
	resHeaders: [key: string, value: string][];
	resBody: any;
};

// derived from key
export type EndUserAnalyticsSummary = {
	endUserId: string;
	reqCount: number;
	errorCount: number;
	totalCost: number;
	totalTiming: number;
	firstTs: number;
	lastTs: number;
	// TODO return model count distribution maybe
};

// Type guard to check if an object is of type EndUserAnalyticsSummary at runtime
function assertEndUserAnalyticsSummary(obj: any): obj is EndUserAnalyticsSummary {
	if (typeof obj !== 'object' || obj === null) {
		throw new TypeError('Object is not valid');
	}
	if (typeof obj.reqCount !== 'number') {
		throw new TypeError('reqCount is not a number');
	}
	if (typeof obj.errorCount !== 'number') {
		throw new TypeError('errorCount is not a number');
	}
	if (typeof obj.totalCost !== 'number') {
		throw new TypeError('totalCost is not a number');
	}
	if (typeof obj.totalTiming !== 'number') {
		throw new TypeError('totalTiming is not a number');
	}
	if (typeof obj.firstTs !== 'number') {
		throw new TypeError('firstTs is not a number');
	}
	if (typeof obj.lastTs !== 'number') {
		throw new TypeError('lastTs is not a number');
	}
	if (typeof obj.endUserId !== 'string') {
		throw new TypeError('endUserId is not a number');
	}
	return true;
}

export type StripeWebhook = {
	id: string;
	webhookSecret: string;
	apiPrivateKey: string;
	serviceAccount: string;
	webhookUrl: string;
};

// Type guard to check if an object is of type StripeWebhook at runtime
function assertStripeWebhook(obj: any): obj is StripeWebhook {
	if (typeof obj !== 'object' || obj === null) {
		throw new TypeError('Object is not valid');
	}
	if (typeof obj.id !== 'string') {
		throw new TypeError('id is not a string');
	}
	if (typeof obj.webhookSecret !== 'string') {
		throw new TypeError('webhookSecret is not a string');
	}
	if (typeof obj.apiPrivateKey !== 'string') {
		throw new TypeError('apiPrivateKey is not a string');
	}
	if (typeof obj.serviceAccount !== 'string') {
		throw new TypeError('serviceAccount is not a string');
	}
	if (typeof obj.webhookUrl !== 'string') {
		throw new TypeError('webhookUrl is not a string');
	}
	
	return true;
}

function isValidJson(str: string) {
	try {
		JSON.parse(str);
		return true;
	} catch (e) {
		return false;
	}
}
// TODO use URLs to validate here or in front
export type ApiProxy = {
	id: string;
	authPublicKey: string;
	authType: AuthProviderType;
	apiUrl: string;
	apiPrivateKey: string;
	schemaVersion: SchemaVersion;
	proxyUrl: string;
	apiReqHeader: string;
	rateLimitUnit: RateLimitUnit;
	rateLimit: number;
	authAppId: string;
};

// Type guard to check if an object is of type ApiProxy at runtime
function assertApiProxy(obj: any): obj is ApiProxy {
	if (!obj.schemaVersion) {
		obj.schemaVersion = SchemaVersion.V1;
	}

	if (typeof obj !== 'object' || obj === null) {
		throw new TypeError('Object is not valid');
	}
	if (typeof obj.authPublicKey !== 'string') {
		throw new TypeError('authPublicKey is not a string');
	}
	if (typeof obj.apiReqHeader !== 'string') {
		throw new TypeError('apiReqHeader is not a string');
	}
	if (typeof obj.id !== 'string') {
		throw new TypeError('id is not a string');
	}
	if (typeof obj.proxyUrl !== 'string') {
		throw new TypeError('proxyUrl is not a string');
	}
	if (typeof obj.apiUrl !== 'string') {
		throw new TypeError('apiUrl is not a string');
	}
	if (typeof obj.authAppId !== 'string') {
		throw new TypeError('authAppId is not a string');
	}
	if (typeof obj.apiPrivateKey !== 'string') {
		throw new TypeError('apiPrivateKey is not a string');
	}
	if (!Object.values(AuthProviderType).includes(obj.authType)) {
		throw new TypeError('authType is not valid');
	}
	if (!Object.values(SchemaVersion).includes(obj.schemaVersion)) {
		throw new TypeError('schemaVersion is not valid');
	}
	if (!Object.values(RateLimitUnit).includes(obj.rateLimitUnit)) {
		throw new TypeError('rateLimitUnit is not valid');
	}
	if (typeof obj.rateLimit !== 'number' || obj.rateLimit < 0) {
		throw new TypeError('rateLimit is not valid');
	}
	return true;
}

function isValidStr(testStr: string) {
	return typeof testStr === 'string' && testStr.trim() !== '';
}

// TODO how to update programmatically
const modelCostsPerMillion: {
	[key: string]: {
		input: number;
		output?: number;
		threshold?: number;
		postThresholdInput?: number;
		postThresholdOutput?: number;
	};
} = {
	// openai
	'gpt-4o': { input: 5, output: 15 },
	'gpt-4o-2024-08-06': { input: 2.5, output: 10 },
	'gpt-4o-2024-05-13': { input: 5, output: 15 },
	'gpt-4o-mini': { input: 0.15, output: 0.6 },
	'gpt-4o-mini-2024-07-18': { input: 0.15, output: 0.6 },
	'text-embedding-3-small': { input: 0.02 },
	'text-embedding-3-large': { input: 0.13 },
	'text-embedding-ada-002': { input: 0.1 },
	// anthropic
	'claude-3-5-sonnet-20240620': { input: 3, output: 3.75 },
	'claude-3-opus-20240229': { input: 15, output: 75 },
	'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
	// gemini
	'gemini-1.5-flash': {
		input: 0.075,
		output: 0.3,
		threshold: 128_000,
		postThresholdInput: 0.15,
		postThresholdOutput: 0.6,
	},
	'gemini-1.5-pro': {
		input: 3.5,
		output: 10.5,
		threshold: 128_000,
		postThresholdInput: 7,
		postThresholdOutput: 21,
	},
	'gemini-1.0-pro': {
		input: 0.5,
		output: 1.5,
	},
};

// this is best effort so it fallsback to 0 cost
// does not support caching, fine tuned models, image and audio models
function estimateCost(usage: LLMUsage): number {
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

function getProxyKey(backmeshUid: string, id: string) {
	return `${getProxiesKey(backmeshUid)}${id}`;
}

function getProxiesKey(backmeshUid: string) {
	return `proxies/${backmeshUid}/`;
}

function getStripeWebhookKey(backmeshUid: string, id: string) {
	return `${getStripeWebhooksKey(backmeshUid)}${id}`;
}

function getStripeWebhooksKey(backmeshUid: string,) {
	return `stripe/${backmeshUid}/`;
}

function getRateLimitKey(
	backmeshUid: string,
	proxyId: string,
	endUserId: string,
	windowStart: number,
) {
	return `limits/${backmeshUid}/${proxyId}/${endUserId}-${windowStart}`;
}

// value is a string endUserId that owns this resource
function getPrivateResourceKey(
	backmeshUid: string,
	proxyId: string,
	resourceId: string,
) {
	return `resources/${backmeshUid}/${proxyId}/${resourceId}`;
}

class ProxyExchangeSummary {
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

	static parseKey(key: string): {
		kSumm: ProxyExchangeSummary;
		endUserId: string;
	} {
		const keyParts = key.split('/');
		/*
		[
			'reqs',
			'gbBbHCDBxqb8zwMk6dCio63jhOP2',
			'FrdhHumtd5UmeeZ3xR3L',
			'L8krqnkRWPXcxjoocPrQh33xTmD3',
			'1725915390445|200|1364|claude-3-5-sonnet-20240620|0.00016125'
		]
		*/
		const endUserId = keyParts[keyParts.length - 2];
		const [ts, status, timing, model, cost] =
			keyParts[keyParts.length - 1].split('|');
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

	newKey(backmeshUid: string, proxyId: string, endUserId: string): string {
		let key = `${getProxyExchangesKey(backmeshUid, proxyId)}${endUserId}/${
			this.ts
		}|${this.status}|${this.timing}`;
		return `${key}|${this.model}|${this.cost}`;
	}
}

function getProxyExchangesKey(backmeshUid: string, proxyId: string) {
	return `reqs/${backmeshUid}/${proxyId}/`;
}

export default {
	async newProxyExchange(
		env: Env,
		proxyReq: ProxyRequest | InvalidProxyRequest,
		ts: number,
		timing: number,
		proxyRes: ProxyResponse,
	) {
		const { backmeshUid, proxyId, endUserId, request } = proxyReq;
		if (!backmeshUid || !proxyId || !endUserId) return;
		const usage = proxyRes.usage;
		const model = usage ? usage.model : undefined;
		const cost = usage ? estimateCost(usage) : undefined;
		const summary = new ProxyExchangeSummary({
			status: proxyRes.response.status,
			ts,
			timing,
			cost,
			model,
		});
		const key = summary.newKey(backmeshUid, proxyId, endUserId);
		await KV.create<ProxyExchange>(env.BACKMESH_KV, key, {
			url: request.url,
			reqHeaders: Array.from(request.headers.entries()),
			reqBody: request.body ? await request.clone().text() : undefined,
			resBody: proxyRes.parsedBody,
			resHeaders: Array.from(proxyRes.response.headers.entries()),
		});
	},
	async getProxyExchangeSummaries(
		env: Env,
		backmeshUid: string,
		proxyId: string,
	): Promise<EndUserAnalyticsSummary[]> {
		const prefix = getProxyExchangesKey(backmeshUid, proxyId);
		const keys = await KV.listKeys(env.BACKMESH_KV, prefix);
		const summaries: { [endUserId: string]: EndUserAnalyticsSummary } = {};

		for (const key of keys) {
			const { kSumm, endUserId } = ProxyExchangeSummary.parseKey(key.name);

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
	},
	/*
		Stripe Webhooks
	*/
	async newStripeWebhook(env: Env, origin: string, backmeshUid: string, value: any): Promise<StripeWebhook> {
		const id = KV.generateId();
		value.id = id;
		value.webhookUrl = `${origin}/v1/stripe/${backmeshUid}/${id}`;
		assertStripeWebhook(value);
		if (!isValidJson(value.serviceAccount)) {
			throw new TypeError('serviceAccount must be a valid JSON string');
		}
		value.webhookSecret = await encrypt(value.webhookSecret, env.PASSWORD);
		value.serviceAccount = await encrypt(value.serviceAccount, env.PASSWORD);
		value.apiPrivateKey = await encrypt(value.apiPrivateKey, env.PASSWORD);
		await KV.create<StripeWebhook>(env.BACKMESH_KV, getStripeWebhookKey(backmeshUid, id), value);
		// do not return secrets
		value.webhookSecret = '';
		value.serviceAccount = '';
		value.apiPrivateKey = '';
		return value;
	},

	async editStripeWebhook(env: Env, backmeshUid: string, id: string, value: any): Promise<StripeWebhook> {
		assertStripeWebhook(value);
		// user is trying to set new values
		if (isValidStr(value.webhookSecret)) {
			value.webhookSecret = await encrypt(value.webhookSecret, env.PASSWORD);
		}
		if (isValidStr(value.serviceAccount)) {
			value.serviceAccount = await encrypt(value.serviceAccount, env.PASSWORD);
		}
		if (isValidStr(value.apiPrivateKey)) {
			value.apiPrivateKey = await encrypt(value.apiPrivateKey, env.PASSWORD);
		}
		await KV.edit<StripeWebhook>(env.BACKMESH_KV, getStripeWebhookKey(backmeshUid, id), value, ['id', 'webhookUrl']);
		// do not return secrets
		value.webhookSecret = '';
		value.serviceAccount = '';
		value.apiPrivateKey = '';
		return value;
	},

	async getAdminStripeWebhook(env: Env, backmeshUid: string, id: string): Promise<StripeWebhook> {
		const key = getStripeWebhookKey(backmeshUid, id);
		const webhook = await KV.get<StripeWebhook>(env.BACKMESH_KV, key);
		assertStripeWebhook(webhook);
		return webhook;
	},

	async getAllStripeWebhooks(env: Env, backmeshUid: string): Promise<StripeWebhook[]> {
		const keys = await KV.listKeys(env.BACKMESH_KV, getStripeWebhooksKey(backmeshUid));
		const webhookPromises = keys.map(async (key) => {
			const webhook = await KV.get<StripeWebhook>(env.BACKMESH_KV, key.name);
			assertStripeWebhook(webhook);
			// Clear sensitive data before returning
			webhook.webhookSecret = '';
			webhook.serviceAccount = '';
			webhook.apiPrivateKey = '';
			return webhook;
		});

		return Promise.all(webhookPromises);
	},

	async delStripeWebhook(env: Env, backmeshUid: string, id: string) {
		const key = getStripeWebhookKey(backmeshUid, id);
		await KV.del(env.BACKMESH_KV, key);
	},

	/*
		API Proxies
	*/
	async newApiProxy(env: Env, origin: string, backmeshUid: string, value: any): Promise<ApiProxy> {
		const id = KV.generateId();
		value.id = id;
		value.proxyUrl = `${origin}/v1/proxy/${backmeshUid}/${id}`;
		assertApiProxy(value);
		value.apiPrivateKey = await encrypt(value.apiPrivateKey, env.PASSWORD);
		await KV.create<ApiProxy>(env.BACKMESH_KV, getProxyKey(backmeshUid, id), value);
		// do not return private key
		value.apiPrivateKey = '';
		return value;
	},

	async editApiProxy(
		env: Env,
		backmeshUid: string,
		proxyId: string,
		value: any,
	): Promise<ApiProxy> {
		assertApiProxy(value);
		// user is trying to set a new one
		if (isValidStr(value.apiPrivateKey)) {
			value.apiPrivateKey = await encrypt(value.apiPrivateKey, env.PASSWORD);
		}
		await KV.edit<ApiProxy>(env.BACKMESH_KV, getProxyKey(backmeshUid, proxyId), value, [
			'id',
			'proxyUrl',
		]);
		// do not return private key
		value.apiPrivateKey = '';
		return value;
	},

	async getApiProxy(env: Env, backmeshUid: string, id: string) {
		const key = getProxyKey(backmeshUid, id);
		const proxy = await KV.get<ApiProxy>(env.BACKMESH_KV, key);
		assertApiProxy(proxy);
		proxy.apiPrivateKey = '';
		return proxy;
	},

	async getAdminApiProxy(env: Env, backmeshUid: string, id: string) {
		const key = getProxyKey(backmeshUid, id);
		const proxy = await KV.get<ApiProxy>(env.BACKMESH_KV, key);
		proxy.apiPrivateKey = await decrypt(proxy.apiPrivateKey, env.PASSWORD);
		assertApiProxy(proxy);
		return proxy;
	},

	async getAllApiProxies(env: Env, backmeshUid: string): Promise<ApiProxy[]> {
		const keys = await KV.listKeys(env.BACKMESH_KV, getProxiesKey(backmeshUid));

		const proxyPromises = keys.map(async (key) => {
			const proxy = await KV.get<ApiProxy>(env.BACKMESH_KV, key.name);
			assertApiProxy(proxy);
			proxy.apiPrivateKey = '';
			return proxy;
		});

		return Promise.all(proxyPromises);
	},

	async delApiProxy(env: Env, backmeshUid: string, id: string) {
		const key = getProxyKey(backmeshUid, id);
		await KV.del(env.BACKMESH_KV, key);
	},

	async newUserResource(
		env: Env,
		{
			backmeshUid,
			proxyId,
			endUserId,
			resourceId,
		}: {
			backmeshUid: string;
			proxyId: string;
			endUserId: string;
			resourceId: string;
		},
	) {
		const key = getPrivateResourceKey(backmeshUid, proxyId, resourceId);
		await env.BACKMESH_KV.put(key, endUserId);
	},

	async isUserResource(
		env: Env,
		{
			backmeshUid,
			proxyId,
			endUserId,
			resourceId,
		}: {
			backmeshUid: string;
			proxyId: string;
			endUserId: string;
			resourceId: string;
		},
	) {
		const key = getPrivateResourceKey(backmeshUid, proxyId, resourceId);
		const kvUid = await env.BACKMESH_KV.get(key);
		return kvUid === endUserId;
	},

	// Sliding window rate limiting per user with retry logic
	async rateLimit(
		env: Env,
		backmeshUid: string,
		apiProxy: ApiProxy,
		endUserId: string,
		retryCount = 0,
	): Promise<boolean> {
		const maxRetries = 3; // Maximum number of retries
		const now = Math.floor(Date.now() / 1000); // Current timestamp in seconds
		const rateLimitWindow = getRateLimitUnitInSecs(apiProxy.rateLimitUnit);
		const windowStart = Math.floor(now / rateLimitWindow) * rateLimitWindow;

		// Generate the KV key for this user and window
		const rateLimitKey = `${getRateLimitKey(backmeshUid, apiProxy.id, endUserId, windowStart)}`;

		// Get the current count from KV
		const value = await env.BACKMESH_KV.get(rateLimitKey);
		let count = value ? parseInt(value) : 0;

		// Check if the rate limit exceeded
		if (count >= apiProxy.rateLimit) {
			return true; // Rate limit exceeded
		}

		// Increment the count
		count += 1;

		// Try to update KV
		try {
			await env.BACKMESH_KV.put(rateLimitKey, count.toString(), {
				expirationTtl: rateLimitWindow, // Set expiration to the window duration
			});
			return false; // Rate limit not exceeded
		} catch (err: any) {
			// Only catch 429s
			if (!err.message.includes('429')) {
				throw err;
			}
			// Handle write contention or other errors
			if (retryCount < maxRetries) {
				const backoffTime = Math.random() * Math.pow(2, retryCount) * 100; // Exponential backoff in ms
				await new Promise((resolve) => setTimeout(resolve, backoffTime));
				return this.rateLimit(env, backmeshUid, apiProxy, endUserId, retryCount + 1); // Retry recursively
			} else {
				// Retries exhausted; fail gracefully
				console.error(`Failed to update rate limit after ${retryCount} retries`);
				return false;
			}
		}
	}
};
