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
	if (!Object.values(AuthProviderType).includes(obj.authType)) {
		throw new TypeError('authType is not valid');
	}
	if (!Object.values(SchemaVersion).includes(obj.schemaVersion)) {
		throw new TypeError('schemaVersion is not valid');
	}
	
	return true;
}

export function isValidJson(str: string) {
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

// TODO how to update programmatically
export const modelCostsPerMillion: {
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
	// cloudflare
	'@cf/meta/llama-3.2-1b-instruct': { input: 0.027, output: 0.201 },
	'@cf/meta/llama-3.2-3b-instruct': { input: 0.051, output: 0.335 },
	'@cf/meta/llama-3.1-8b-instruct-fp8-fast': { input: 0.045, output: 0.384 },
	'@cf/meta/llama-3.2-11b-vision-instruct': { input: 0.049, output: 0.676 },
	'@cf/meta/llama-3.1-70b-instruct-fp8-fast': { input: 0.293, output: 2.253 },
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 0.293, output: 2.253 },
	'@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': { input: 0.497, output: 4.881 },
	'@cf/mistral/mistral-7b-instruct-v0.1': { input: 0.11, output: 0.19 },
	'@cf/meta/llama-3.1-8b-instruct': { input: 0.282, output: 0.827 },
	'@cf/meta/llama-3.1-8b-instruct-fp8': { input: 0.152, output: 0.287 },
	'@cf/meta/llama-3.1-8b-instruct-awq': { input: 0.123, output: 0.266 },
	'@cf/meta/llama-3-8b-instruct': { input: 0.282, output: 0.827 },
	'@cf/meta/llama-3-8b-instruct-awq': { input: 0.123, output: 0.266 },
	'@cf/meta/llama-2-7b-chat-fp16': { input: 0.556, output: 6.667 },
};

export interface Crud<T> {
	create(env: Env, origin: string, backmeshUid: string, value: any): Promise<T>;
	getAdmin(env: Env, backmeshUid: string, id: string): Promise<T>;
	get(env: Env, backmeshUid: string, id: string): Promise<T>;
	edit(env: Env, backmeshUid: string, id: string, value: any): Promise<T>;
	getAll(env: Env, backmeshUid: string): Promise<T[]>;
	delete(env: Env, backmeshUid: string, id: string): Promise<void>;
	getKey(backmeshUid: string, id: string): string;
	getListKey(backmeshUid: string): string;
}

export type CustomClaims = {[key: string]: any};