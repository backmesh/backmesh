import auth from './services/auth';
import { apiProxyCrud } from './services/proxy';
import { EndUserResource } from './services/permissions';
import { ProxyExchangeSummary } from './services/analytics';
import rateLimit from './services/limit';

import posthog from './services/gateways/posthog';
import { LLMUsage, InvalidProxyRequest, ProxyRequest, ProxyResponse } from './services/repos/models';

async function getLLMUsage(
	req: ProxyRequest,
	parsedBody: any,
): Promise<LLMUsage | undefined> {
	try {
		if (parsedBody.usage && req.apiProxy.apiUrl === 'https://api.openai.com') {
			return {
				inputTokens: parsedBody.usage.prompt_tokens,
				outputTokens: parsedBody.usage.completion_tokens,
				model: parsedBody.model,
			};
		} else if (
			parsedBody.usage &&
			req.apiProxy.apiUrl === 'https://api.anthropic.com'
		) {
			return {
				inputTokens: parsedBody.usage.input_tokens,
				outputTokens: parsedBody.usage.output_tokens,
				model: parsedBody.model,
			};
		} else if (
			parsedBody.usageMetadata &&
			req.apiProxy.apiUrl === 'https://generativelanguage.googleapis.com'
		) {
			return {
				inputTokens: parsedBody.usageMetadata.promptTokenCount,
				// inputCachedTokens: parsedBody.usageMetadata.cachedContentTokenCount,
				outputTokens: parsedBody.usageMetadata.candidatesTokenCount,
				// "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=$GOOGLE_API_KEY"
				model: req.path.split('/').pop()!.split(':').shift()!,
			};
		} else if (
			parsedBody.result.usage &&
			req.apiProxy.apiUrl === 'https://api.cloudflare.com'
		) {
			return {
				inputTokens: parsedBody.result.usage.prompt_tokens,
				outputTokens: parsedBody.result.usage.completion_tokens,
				// "https://api.cloudflare.com/client/v4/accounts/2f94e65d5df1e6e22d0ef9a8f8f81465/ai/run/@cf/meta/llama-3-8b-instruct"
				model: `@${req.path.split('@').pop()!}`,
			};
		}
	} catch (e) {}
}

export default {
	async validate(
		request: Request,
		env: Env,
	): Promise<InvalidProxyRequest | ProxyRequest> {
		const requestUrl = new URL(request.url);
		const parts = requestUrl.pathname.split('/').filter((part) => part);
		const path = parts.slice(4).join('/');
		// /v1/proxy/${backmeshUid}/${apiProxyName}/
		const backmeshUid = parts.at(2);
		const proxyId = parts.at(3);
		if (!backmeshUid || !proxyId) {
			return new InvalidProxyRequest({
				request,
				proxyId,
				backmeshUid,
				path,
				response: new Response('Invalid pathname', { status: 400 }),
			});
		}
		let apiProxy;
		try {
			apiProxy = await apiProxyCrud.getAdmin(env, backmeshUid, proxyId);
		} catch (error: any) {
			console.error(error);
			const status = error instanceof TypeError ? 404 : 500;
			return new InvalidProxyRequest({
				request,
				proxyId,
				backmeshUid,
				path,
				apiProxy,
				response: new Response(error.message ?? 'Unknown error', { status }),
			});
		}
		const authHeader = auth.getAuthHeader(request, apiProxy.apiReqHeader);
		if (authHeader === null)
			return new InvalidProxyRequest({
				request,
				proxyId,
				backmeshUid,
				path,
				apiProxy,
				response: new Response('Missing or invalid Authorization header', {
					status: 401,
				}),
			});
		const endUserId = await auth.getUid(authHeader.extractedJwt, apiProxy);
		if (endUserId === null)
			return new InvalidProxyRequest({
				request,
				proxyId,
				backmeshUid,
				path,
				apiProxy,
				authHeader,
				response: new Response('Invalid token', { status: 401 }),
			});
		return new ProxyRequest({
			apiProxy,
			request,
			authHeader,
			proxyId,
			backmeshUid,
			endUserId,
			path,
		});
	},
	async fetch(
		proxyRequest: ProxyRequest | InvalidProxyRequest,
		env: Env,
	): Promise<ProxyResponse> {
		if (proxyRequest instanceof InvalidProxyRequest)
			return { response: proxyRequest.response };
		const { apiProxy, request, authHeader, proxyId, backmeshUid, endUserId, path } =
			proxyRequest;
		const rL = await rateLimit(env, backmeshUid, apiProxy, endUserId);
		if (rL)
			return {
				response: new Response('Backmesh request limit exceeded', { status: 429 }),
			};
		const requestUrl = new URL(request.url);
		let fullApiUrl =
			apiProxy.apiUrl + (apiProxy.apiUrl.endsWith('/') ? '' : '/') + path;

		// v1/assistants, v1/vector_stores and v1/fine_tuning can be added as private endpoints
		// whitelist of routes supported until someone complains and then understand their use case
		const pathParts = path.split('/');
		const route = pathParts[1];
		if (fullApiUrl.startsWith('https://api.openai.com')) {
			const allowedPaths = [
				'audio',
				'chat',
				'models',
				'images',
				'moderations',
				'files', // private ones
				'threads', // private ones
			];
			if (!allowedPaths.some((p) => route === p)) {
				return { response: new Response('Forbidden', { status: 403 }) };
			}
		}

		if (fullApiUrl.startsWith('https://api.anthropic.com')) {
			const allowedInitPaths = ['v1/messages'];
			if (!allowedInitPaths.some((p) => path === p)) {
				return { response: new Response('Forbidden', { status: 403 }) };
			}
		}

		// https://ai.google.dev/api/all-methods
		if (fullApiUrl.startsWith('https://generativelanguage.googleapis.com')) {
			const allowedInitPaths = [
				'v1beta/files',
				'upload/v1beta/files',
				'v1beta/models',
			];
			if (!allowedInitPaths.some((p) => path.startsWith(p))) {
				return { response: new Response('Forbidden', { status: 403 }) };
			}
		}

		if (fullApiUrl.startsWith('https://api.cloudflare.com')) {
			const allowedPaths = ['ai/run'];
			// Cloudflare API has a different structure, so we cannot check the route directly
			// https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/run/$MODEL_NAME 
			if (!allowedPaths.some((p) => path.includes(p))) {
				return { response: new Response('Forbidden', { status: 403 }) };
			}
		}

		// Add existing query parameters
		if (requestUrl.searchParams.size > 0) {
			const url = new URL(fullApiUrl);
			requestUrl.searchParams.forEach((value, key) => {
				url.searchParams.append(key, value);
			});
			fullApiUrl = url.toString();
		}

		const init: RequestInit = {
			method: request.method,
			headers: auth.newProxyHeaders(request, authHeader, apiProxy.apiPrivateKey),
		};

		// we can't fire request here because file deletions might be forbidden later on
		let response, parsedBody: any;

		// GET and HEAD requests do not have a body
		if (request.body) {
			init.body = await request.clone().text();
		}

		const { readable, writable } = new TransformStream();
		if (fullApiUrl.startsWith('https://generativelanguage.googleapis.com')) {
			if (
				path === 'upload/v1beta/files' &&
				requestUrl.searchParams.has('upload_id')
			) {
				// parse response without consuming original
				response = await fetch(fullApiUrl, init);
				parsedBody = await response.clone().json();
				const file = parsedBody.file;

				await EndUserResource.create(env, {
					backmeshUid,
					proxyId: apiProxy.id,
					endUserId,
					// files/lw388m83m4w8
					resourceId: file.name.split('/').pop(),
				});
			} else if (route === 'files' && pathParts.length === 3) {
				// GET or DELETE
				const resourceId = pathParts[2];
				const isOwner = await EndUserResource.exists(env, {
					backmeshUid,
					proxyId: apiProxy.id,
					endUserId,
					resourceId,
				});
				if (!isOwner)
					return { response: new Response('Forbidden', { status: 403 }) };
				// GET v1/files lists all files
				// parse response, grab id and set in KV
			} else if (pathParts.length === 2 && route === 'files') {
				// parse response and filter files that do not belong to this user
				// assumes JSON
				response = await fetch(fullApiUrl, init);
				parsedBody = await response.clone().json();
				// TODO handle pagination
				const filteredFiles = await Promise.all(
					(parsedBody.files as any[]).map(async (file) => {
						const isOwner = await EndUserResource.exists(env, {
							backmeshUid,
							proxyId: apiProxy.id,
							endUserId,
							resourceId: file.name.split('/').pop(),
						});
						return isOwner ? file : null;
					}),
				).then((results) => results.filter((file) => file !== null));
				const reconstructedResponse = {
					...parsedBody,
					files: filteredFiles,
				};
				const writer = writable.getWriter();
				writer.write(
					new TextEncoder().encode(JSON.stringify(reconstructedResponse)),
				);
				writer.close();

				return { response: new Response(readable, response), parsedBody };
			}
		}

		// TODO support /v1/uploads and resulting file created
		if (apiProxy.apiUrl.startsWith('https://api.openai.com')) {
			if (route === 'files' || route === 'threads') {
				if (request.method === 'POST') {
					// parse response without consuming original
					response = await fetch(fullApiUrl, init);
					const parsedBody: any = await response.clone().json();
					const resourceId = parsedBody.id;
					await EndUserResource.create(env, {
						backmeshUid,
						proxyId,
						endUserId,
						resourceId,
					});
					// Files API
					// ---------
					// DELETE or GET with id
					// v1/files/${fileId}
					// or GET contents
					// v1/files/${fileId}/content
					//
					// Threads API
					// -----------
					// DELETE or GET with id plus any action on it
					// v1/threads/${threadId}/...
				} else if (pathParts.length === 3 || pathParts.length === 4) {
					const resourceId = pathParts[2];
					const isOwner = await EndUserResource.exists(env, {
						backmeshUid,
						proxyId,
						endUserId,
						resourceId,
					});
					if (!isOwner)
						return { response: new Response('Forbidden', { status: 403 }) };
					// GET v1/files lists all files
					// parse response, grab id and set in KV
				} else if (
					request.method === 'GET' &&
					pathParts.length === 2 &&
					route === 'files'
				) {
					// parse response and filter files that do not belong to this user
					// assumes JSON
					response = await fetch(fullApiUrl, init);
					const parsedBody: any = await response.clone().json();
					const filteredData = await Promise.all(
						(parsedBody.data as any[]).map(async (file) => {
							const isOwner = await EndUserResource.exists(env, {
								backmeshUid,
								proxyId,
								endUserId,
								resourceId: file.id,
							});
							return isOwner ? file : null;
						}),
					).then((results) => results.filter((file) => file !== null));
					const reconstructedResponse = {
						...parsedBody,
						data: filteredData,
					};
					const writer = writable.getWriter();
					writer.write(
						new TextEncoder().encode(JSON.stringify(reconstructedResponse)),
					);
					writer.close();

					return {
						response: new Response(readable, response),
						parsedBody,
					};
				}
			}
		}

		if (!response) {
			response = await fetch(fullApiUrl, init);
		}

		if (!response.body) {
			return { response: new Response('No body in response', { status: 500 }) };
		}

		const contentType = response.headers.get('Content-Type');
		if (!parsedBody && contentType && contentType.includes('application/json')) {
			parsedBody = await response.clone().json();
		}

		// Start pumping the body. NOTE: No await!
		response.body.pipeTo(writable);

		// ... and deliver our Response while that’s running.
		return {
			parsedBody,
			response: new Response(readable, response),
			usage: await getLLMUsage(proxyRequest, parsedBody),
		};
	},
	async postprocessing(
		proxyReq: ProxyRequest | InvalidProxyRequest,
		proxyRes: ProxyResponse,
		ts: number,
		timing: number,
		env: Env,
	) {
		if (proxyReq instanceof ProxyRequest)
			await ProxyExchangeSummary.create(env, proxyReq, ts, timing, proxyRes);
		await posthog.captureProxyReq(proxyReq, proxyRes, timing, env);
	},
};
