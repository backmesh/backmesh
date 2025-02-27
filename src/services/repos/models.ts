import Stripe from "stripe";
import prices from "./prices.json";

export type AuthHeader = {
	field: string;
	value: string;
	extractedJwt: string;
};

export class InvalidProxyRequest {
	endUserId?: string;
	backmeshUid?: string;
	proxyId?: string;
	authHeader?: AuthHeader;
	apiProxy?: ApiProxy;
	request!: Request;
	path!: string;
	response!: Response;

	constructor(init: Partial<InvalidProxyRequest>) {
		Object.assign(this, init);
	}
}

export class ProxyRequest {
	endUserId!: string;
	backmeshUid!: string;
	proxyId!: string;
	authHeader!: AuthHeader;
	request!: Request;
	apiProxy!: ApiProxy;
	path!: string;

	constructor(init: ProxyRequest) {
		Object.assign(this, init);
	}
}

export class ProxyResponse {
	response!: Response;
	parsedBody?: any;
	usage?: LLMUsage;

	constructor(init: ProxyResponse) {
		Object.assign(this, init);
	}
}

export type LLMUsage = {
	model: string;
	inputTokens: number;
	outputTokens?: number; // missing for embedding models
};

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

export type ProxyExchange = {
	url: string;
	reqHeaders: [key: string, value: string][];
	reqBody?: string;
	resHeaders: [key: string, value: string][];
	resBody: any;
};

// derived from key
export type EndUserAnalytics = {
	endUserId: string;
	reqCount: number;
	errorCount: number;
	totalCost: number;
	totalTiming: number;
	firstTs: number;
	lastTs: number;
	// TODO return model count distribution maybe
};

// Type guard to check if an object is of type EndUserAnalytics at runtime
export function assertEndUserAnalytics(obj: any): obj is EndUserAnalytics {
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

export type StripeIntegration = {
	id: string;
	webhookSecret: string;
	stripePrivateKey: string;
	authPrivateKey: string;
	webhookUrl: string;
	authType: AuthProviderType;
	schemaVersion: SchemaVersion;
	// in supabase this case the authAppId is the project or app url
	// https://naxywnoolzuwzkinwekg.supabase.co
	authAppId: string;
};

// Type guard to check if an object is of type StripeIntegration at runtime
export function assertStripeIntegration(obj: any): obj is StripeIntegration {
	if (!obj.schemaVersion) {
		obj.schemaVersion = SchemaVersion.V1;
	}
	if (typeof obj !== 'object' || obj === null) {
		throw new TypeError('Object is not valid');
	}
	if (typeof obj.id !== 'string') {
		throw new TypeError('id is not a string');
	}
	if (typeof obj.webhookSecret !== 'string') {
		throw new TypeError('webhookSecret is not a string');
	}
	if (typeof obj.stripePrivateKey !== 'string') {
		throw new TypeError('stripePrivateKey is not a string');
	}
	if (typeof obj.authPrivateKey !== 'string') {
		throw new TypeError('authPrivateKey is not a string');
	}
	if (typeof obj.webhookUrl !== 'string') {
		throw new TypeError('webhookUrl is not a string');
	}
	if (typeof obj.authAppId !== 'string') {
		throw new TypeError('authAppId is not a string');
	}
	if (!Object.values(AuthProviderType).includes(obj.authType)) {
		throw new TypeError('authType is not valid');
	}
	if (!Object.values(SchemaVersion).includes(obj.schemaVersion)) {
		throw new TypeError('schemaVersion is not valid');
	}
	
	return true;
}

export function isValidJsonStr(str: string) {
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
	// in supabase this case the authAppId is the project or app url
	// https://naxywnoolzuwzkinwekg.supabase.co
	authAppId: string;
	allowedPaths?: string[];
};

// Type guard to check if an object is of type ApiProxy at runtime
export function assertApiProxy(obj: any): obj is ApiProxy {
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

export function isValidStr(testStr: string) {
	return typeof testStr === 'string' && testStr.trim() !== '';
}

// Define interface for model pricing
export interface ModelPricing {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_audio_token?: number;
  output_cost_per_audio_token?: number;
  input_cost_per_token_batches?: number;
  output_cost_per_token_batches?: number;
  [key: string]: any;
}

// cloudflare
// https://developers.cloudflare.com/workers-ai/platform/pricing/
const cloudflarePrices = {
	'@cf/meta/llama-3.2-1b-instruct': { input_cost_per_token: 0.027 * 1e6, output_cost_per_token: 0.201 * 1e6 },
	'@cf/meta/llama-3.2-3b-instruct': { input_cost_per_token: 0.051 * 1e6, output_cost_per_token: 0.335 * 1e6 },
	'@cf/meta/llama-3.1-8b-instruct-fp8-fast': { input_cost_per_token: 0.045 * 1e6, output_cost_per_token: 0.384 * 1e6 },
	'@cf/meta/llama-3.2-11b-vision-instruct': { input_cost_per_token: 0.049 * 1e6, output_cost_per_token: 0.676 * 1e6 },
	'@cf/meta/llama-3.1-70b-instruct-fp8-fast': { input_cost_per_token: 0.293 * 1e6, output_cost_per_token: 2.253 * 1e6 },
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input_cost_per_token: 0.293 * 1e6, output_cost_per_token: 2.253 * 1e6 },
	'@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': { input_cost_per_token: 0.497 * 1e6, output_cost_per_token: 4.881 * 1e6 },
	'@cf/mistral/mistral-7b-instruct-v0.1': { input_cost_per_token: 0.11 * 1e6, output_cost_per_token: 0.19 * 1e6 },
	'@cf/meta/llama-3.1-8b-instruct': { input_cost_per_token: 0.282 * 1e6, output_cost_per_token: 0.827 * 1e6 },
	'@cf/meta/llama-3.1-8b-instruct-fp8': { input_cost_per_token: 0.152 * 1e6, output_cost_per_token: 0.287 * 1e6 },
	'@cf/meta/llama-3.1-8b-instruct-awq': { input_cost_per_token: 0.123 * 1e6, output_cost_per_token: 0.266 * 1e6 },
	'@cf/meta/llama-3-8b-instruct': { input_cost_per_token: 0.282 * 1e6, output_cost_per_token: 0.827 * 1e6 },
	'@cf/meta/llama-3-8b-instruct-awq': { input_cost_per_token: 0.123 * 1e6, output_cost_per_token: 0.266 * 1e6 },
	'@cf/meta/llama-2-7b-chat-fp16': { input_cost_per_token: 0.556 * 1e6, output_cost_per_token: 6.667 * 1e6 },
};

export const MODEL_PRICES: { [key: string]: ModelPricing } = {
	...cloudflarePrices,
	...prices,
};

export interface Crud<T> {
	// create for stripecrud has no origin
	getAdmin(env: Env, backmeshUid: string, id: string): Promise<T>;
	edit(env: Env, backmeshUid: string, id: string, value: any): Promise<T>;
	getAll(env: Env, backmeshUid: string): Promise<T[]>;
	delete(env: Env, backmeshUid: string, id: string): Promise<void>;
	getKey(backmeshUid: string, id: string): string;
	getListKey(backmeshUid: string): string;
}

export type CustomClaims = {[key: string]: any};

export interface StripeSubscriptionData {
  status: Stripe.Subscription.Status;
  prods: string[];
}

export type StripeSubscriptions = {
	[subscriptionId: string]: StripeSubscriptionData;
};