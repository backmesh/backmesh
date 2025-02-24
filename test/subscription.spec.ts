import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';

import Subscription from '../src/services/subscription';
import { updateClaims } from '../src/services/subscription';

describe('Subscription', () => {
	it('has valid subscription', () => {
		const claims = {
			stripe_subs: {
				sub_1QuhibIz61apsROqSAQ1LoSU: {
					status: 'active',
					prods: ['1xprod_RaNeaDpniWdiK4'],
				},
			},
		};
		expect(Subscription.hasValidSubscription(claims)).toBe(true);
	});
	it('has invalid subscription', () => {
		const claims = {
			stripe_subs: {
				sub_1QuhibIz61apsROqSAQ1LoSU: {
					status: 'canceled',
					prods: ['1xprod_RaNeaDpniWdiK4'],
				},
			},
		};
		expect(Subscription.hasValidSubscription(claims)).toBe(false);
	});

	describe('updateClaims', () => {
		it('adds new subscription to empty claims', () => {
			const existingClaims = {};
			const subscription = {
				id: 'sub_123',
				status: 'active',
				items: {
					data: [{
						quantity: 2,
						price: {
							product: 'prod_abc'
						}
					}]
				}
			} as Stripe.Subscription;

			const updatedClaims = updateClaims(existingClaims, subscription);
			
			expect(updatedClaims).toEqual({
				stripe_subs: {
					'sub_123': {
						status: 'active',
						prods: ['2xprod_abc']
					}
				}
			});
		});

		it('updates existing subscription in claims', () => {
			const existingClaims = {
				stripe_subs: {
					'sub_123': {
						status: 'trialing',
						prods: ['1xprod_abc']
					}
				},
				other_claim: 'value'
			};

			const subscription = {
				id: 'sub_123',
				status: 'active',
				items: {
					data: [{
						quantity: 2,
						price: {
							product: 'prod_abc'
						}
					}]
				}
			} as Stripe.Subscription;

			const updatedClaims = updateClaims(existingClaims, subscription);
			
			expect(updatedClaims).toEqual({
				stripe_subs: {
					'sub_123': {
						status: 'active',
						prods: ['2xprod_abc']
					}
				},
				other_claim: 'value'
			});
		});

		it('handles multiple products in subscription', () => {
			const existingClaims = {};
			const subscription = {
				id: 'sub_123',
				status: 'active',
				items: {
					data: [
						{
							quantity: 2,
							price: {
								product: 'prod_abc'
							}
						},
						{
							quantity: 1,
							price: {
								product: 'prod_xyz'
							}
						}
					]
				}
			} as Stripe.Subscription;

			const updatedClaims = updateClaims(existingClaims, subscription);
			
			expect(updatedClaims).toEqual({
				stripe_subs: {
					'sub_123': {
						status: 'active',
						prods: ['2xprod_abc', '1xprod_xyz']
					}
				}
			});
		});
	});
});
