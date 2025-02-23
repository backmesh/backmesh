export class EndUserResource {
	// value is a string endUserId that owns this resource
	static getKey(
		backmeshUid: string,
		proxyId: string,
		resourceId: string,
	) {
		return `resources/${backmeshUid}/${proxyId}/${resourceId}`;
	}

	// register a new resource (e.g. thread, file) created by the end user in this LLM API
	// this will be used to check if the end user is the owner of the resource
	static async create(
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
		const key = EndUserResource.getKey(backmeshUid, proxyId, resourceId);
		await env.BACKMESH_KV.put(key, endUserId);
	}

	// check if the end user owns the resource
	static async exists(
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
		const key = EndUserResource.getKey(backmeshUid, proxyId, resourceId);
		const kvUid = await env.BACKMESH_KV.get(key);
		return kvUid === endUserId;
	}
}
