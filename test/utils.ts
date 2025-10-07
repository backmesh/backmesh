export async function getTokenFromFirebaseKey(
	publicFirebaseKey: string,
	email: string,
	password: string,
): Promise<string> {
	console.log(`Attempting Firebase authentication for email: ${email}`);
	
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
	
	try {
		const response = await fetch(
			`https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${publicFirebaseKey}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					email: email,
					password: password,
					returnSecureToken: true,
				}),
				signal: controller.signal,
			},
		);

		clearTimeout(timeoutId);

		if (!response.ok) {
			const errorText = await response.text();
			console.error('Firebase auth error response:', errorText);
			throw new Error(`Firebase authentication failed: ${response.status} ${response.statusText}`);
		}

		const data: any = await response.json();
		console.log(`Firebase authentication successful for email: ${email}`);
		return data.idToken;
	} catch (error) {
		clearTimeout(timeoutId);
		if (error.name === 'AbortError') {
			throw new Error('Firebase authentication timed out after 30 seconds');
		}
		console.error('Firebase authentication error:', error);
		throw error;
	}
}

export async function getTokenFromSupabase({
	supabaseKey,
	projectUrl,
	email,
	password,
}: {
	supabaseKey: string;
	projectUrl: string;
	email: string;
	password: string;
}): Promise<string> {
	const response = await fetch(`${projectUrl}/auth/v1/token?grant_type=password`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			apikey: supabaseKey,
		},
		body: JSON.stringify({
			email: email,
			password: password,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		console.error('Error response text:', errorText);
		throw new Error('Error verifying password: ' + response.statusText);
	}

	const data: any = await response.json();
	return data.access_token;
}