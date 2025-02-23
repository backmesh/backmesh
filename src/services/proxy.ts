import { ApiProxy, Crud, assertApiProxy, isValidStr } from "./repos/models";
import KV from "./repos/kv";
import { encrypt, decrypt } from "./crypto";

class ApiProxyCrud implements Crud<ApiProxy> {
	constructor(){}

	getKey(backmeshUid: string, id: string) {
		return `${this.getListKey(backmeshUid)}${id}`;
	}
	
	getListKey(backmeshUid: string) {
		return `proxies/${backmeshUid}/`;
	}

	async create(env: Env, origin: string, backmeshUid: string, value: any): Promise<ApiProxy> {
		const id = KV.generateId();
		value.id = id;
		value.proxyUrl = `${origin}/v1/proxy/${backmeshUid}/${id}`;
		assertApiProxy(value);
		value.apiPrivateKey = await encrypt(value.apiPrivateKey, env.PASSWORD);
		await KV.create<ApiProxy>(env.BACKMESH_KV, this.getKey(backmeshUid, id), value);
		// do not return private key
		value.apiPrivateKey = '';
		return value;
	}

	async edit(
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
		await KV.edit<ApiProxy>(env.BACKMESH_KV, this.getKey(backmeshUid, proxyId), value, [
			'id',
			'proxyUrl',
		]);
		// do not return private key
		value.apiPrivateKey = '';
		return value;
	}

	async get(env: Env, backmeshUid: string, id: string) {
		const key = this.getKey(backmeshUid, id);
		const proxy = await KV.get<ApiProxy>(env.BACKMESH_KV, key);
		assertApiProxy(proxy);
		proxy.apiPrivateKey = '';
		return proxy;
	}

	async getAdmin(env: Env, backmeshUid: string, id: string) {
		const key = this.getKey(backmeshUid, id);
		const proxy = await KV.get<ApiProxy>(env.BACKMESH_KV, key);
		proxy.apiPrivateKey = await decrypt(proxy.apiPrivateKey, env.PASSWORD);
		assertApiProxy(proxy);
		return proxy;
	}

	async getAll(env: Env, backmeshUid: string): Promise<ApiProxy[]> {
		const keys = await KV.listKeys(env.BACKMESH_KV, this.getListKey(backmeshUid));

		const proxyPromises = keys.map(async (key) => {
			const proxy = await KV.get<ApiProxy>(env.BACKMESH_KV, key.name);
			assertApiProxy(proxy);
			proxy.apiPrivateKey = '';
			return proxy;
		});

		return Promise.all(proxyPromises);
	}

	async delete(env: Env, backmeshUid: string, id: string) {
		const key = this.getKey(backmeshUid, id);
		await KV.del(env.BACKMESH_KV, key);
	}
}

export const apiProxyCrud = new ApiProxyCrud();