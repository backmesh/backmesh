import { assertStripeWebhook, StripeWebhook, isValidJson, isValidStr } from "./repos/models";
import KV from "./repos/kv";
import { Crud } from "./repos/models";
import { encrypt } from "./crypto";

class StripeWebhookCrud implements Crud<StripeWebhook> {
	constructor(){}

	async get(env: Env, backmeshUid: string, id: string): Promise<StripeWebhook> {
		throw new Error('Not implemented');
	}

	getKey(backmeshUid: string, id: string) {
		return `${this.getListKey(backmeshUid)}${id}`;
	}

	getListKey(backmeshUid: string,) {
		return `stripe/${backmeshUid}/`;
	}
	async create(env: Env, origin: string, backmeshUid: string, value: any): Promise<StripeWebhook> {
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
		await KV.create<StripeWebhook>(env.BACKMESH_KV, this.getKey(backmeshUid, id), value);
		// do not return secrets
		value.webhookSecret = '';
		value.serviceAccount = '';
		value.apiPrivateKey = '';
		return value;
	}

	async edit(env: Env, backmeshUid: string, id: string, value: any): Promise<StripeWebhook> {
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
		await KV.edit<StripeWebhook>(env.BACKMESH_KV, this.getKey(backmeshUid, id), value, ['id', 'webhookUrl']);
		// do not return secrets
		value.webhookSecret = '';
		value.serviceAccount = '';
		value.apiPrivateKey = '';
		return value;
	}

	async getAdmin(env: Env, backmeshUid: string, id: string): Promise<StripeWebhook> {
		const key = this.getKey(backmeshUid, id);
		const webhook = await KV.get<StripeWebhook>(env.BACKMESH_KV, key);
		assertStripeWebhook(webhook);
		return webhook;
	}

	async getAll(env: Env, backmeshUid: string): Promise<StripeWebhook[]> {
		const keys = await KV.listKeys(env.BACKMESH_KV, this.getListKey(backmeshUid));
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
	}

	async delete(env: Env, backmeshUid: string, id: string) {
		const key = this.getKey(backmeshUid, id);
		await KV.del(env.BACKMESH_KV, key);
	}

}

export const stripeWebhookCrud = new StripeWebhookCrud();
