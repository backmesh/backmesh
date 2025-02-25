import { assertStripeIntegration, StripeIntegration, isValidJsonStr, isValidStr, AuthProviderType } from "./repos/models";
import KV from "./repos/kv";
import { Crud } from "./repos/models";
import { decrypt, encrypt } from "./crypto";

class StripeIntegrationCrud implements Crud<StripeIntegration> {
	constructor(){}

	getKey(backmeshUid: string, id: string) {
		return `${this.getListKey(backmeshUid)}${id}`;
	}

	getListKey(backmeshUid: string,) {
		return `stripe/${backmeshUid}/`;
	}
	async create(env: Env, backmeshUid: string, value: any): Promise<StripeIntegration> {
		console.log('create', value);
		assertStripeIntegration(value);
		if (value.authType === AuthProviderType.FIREBASE && !isValidJsonStr(value.authPrivateKey)) {
			throw new TypeError('serviceAccount must be a valid JSON string');
		}
		value.webhookSecret = await encrypt(value.webhookSecret, env.PASSWORD);
		value.authPrivateKey = await encrypt(value.authPrivateKey, env.PASSWORD);
		value.stripePrivateKey = await encrypt(value.stripePrivateKey, env.PASSWORD);
		await KV.create<StripeIntegration>(env.BACKMESH_KV, this.getKey(backmeshUid, value.id), value);
		// do not return secrets
		value.webhookSecret = '';
		value.authPrivateKey = '';
		value.stripePrivateKey = '';
		return value;
	}

	async edit(env: Env, backmeshUid: string, id: string, value: any): Promise<StripeIntegration> {
		assertStripeIntegration(value);
		// user is trying to set new values
		if (isValidStr(value.webhookSecret)) {
			value.webhookSecret = await encrypt(value.webhookSecret, env.PASSWORD);
		}
		if (isValidStr(value.authPrivateKey)) {
			if (value.authType === AuthProviderType.FIREBASE && !isValidJsonStr(value.authPrivateKey)) {
				throw new TypeError('serviceAccount must be a valid JSON string');
			}
			value.authPrivateKey = await encrypt(value.authPrivateKey, env.PASSWORD);
		}
		if (isValidStr(value.stripePrivateKey)) {
			value.stripePrivateKey = await encrypt(value.stripePrivateKey, env.PASSWORD);
		}
		await KV.edit<StripeIntegration>(env.BACKMESH_KV, this.getKey(backmeshUid, id), value, ['id', 'webhookUrl']);
		// do not return secrets
		value.webhookSecret = '';
		value.authPrivateKey = '';
		value.stripePrivateKey = '';
		return value;
	}

	async getAdmin(env: Env, backmeshUid: string, id: string): Promise<StripeIntegration> {
		const key = this.getKey(backmeshUid, id);
		const webhook = await KV.get<StripeIntegration>(env.BACKMESH_KV, key);
		webhook.webhookSecret = await decrypt(webhook.webhookSecret, env.PASSWORD);
		webhook.authPrivateKey = await decrypt(webhook.authPrivateKey, env.PASSWORD);
		webhook.stripePrivateKey = await decrypt(webhook.stripePrivateKey, env.PASSWORD);
		assertStripeIntegration(webhook);
		return webhook;
	}

	async getAll(env: Env, backmeshUid: string): Promise<StripeIntegration[]> {
		const keys = await KV.listKeys(env.BACKMESH_KV, this.getListKey(backmeshUid));
		const webhookPromises = keys.map(async (key) => {
			const webhook = await KV.get<StripeIntegration>(env.BACKMESH_KV, key.name);
			assertStripeIntegration(webhook);
			// Clear sensitive data before returning
			webhook.webhookSecret = '';
			webhook.authPrivateKey = '';
			webhook.stripePrivateKey = '';
			return webhook;
		});

		return Promise.all(webhookPromises);
	}

	async delete(env: Env, backmeshUid: string, id: string) {
		const key = this.getKey(backmeshUid, id);
		await KV.del(env.BACKMESH_KV, key);
	}

}

export const stripeIntegrationCrud = new StripeIntegrationCrud();
