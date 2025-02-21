import { InvalidProxyRequest, ProxyRequest, ProxyResponse } from '../../proxy';

async function captureEvent(name: string, properties: any) {
	const payload = {
		api_key: 'phc_fZ3tyt5smshwvm17JYlrU8PbxUVlOoakvH2M5b6ktdO',
		event: name,
		properties,
	};
	await fetch('https://app.posthog.com/capture/', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(payload),
	});
}

export default {
	async captureProxyReq(
		req: ProxyRequest | InvalidProxyRequest,
		res: ProxyResponse,
		timing: number,
		env: any,
	) {
		// ignore if tests
		if (env.TEST_USER_PASS !== undefined) return;
		const { path, proxyId, backmeshUid, endUserId } = req;
		await captureEvent('proxy_request', {
			distinct_id: backmeshUid,
			end_user_id: endUserId,
			proxy_id: proxyId,
			method: req.request.method,
			status: res.response.status,
			timing,
			path,
		});
	},
};
