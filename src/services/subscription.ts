import Stripe from "stripe";

type CustomClaims = {[key: string]: any};

// TODO create wrapper that support supabase by passing AuthProviderType
export default {
  hasValidSubscription(claims: CustomClaims) {
    const stripeSubs = claims['stripe_subs'];
    if (!stripeSubs) return false;
    for (const stripeSubId of Object.keys(stripeSubs)) {
      const stripeSub = stripeSubs[stripeSubId];
      if (stripeSub !== undefined && (stripeSub.status === 'active' || stripeSub.status === 'trialing')) {
        return true;
      }
    }
    return false;
  },
  // TODO remove cancelled subscriptions to save space?
  updateClaims(existingClaims: CustomClaims, subscription: Stripe.Subscription): CustomClaims {
    const products = subscription.items.data.map(item => `${item.quantity}x${item.price.product}`);
    // Merge new claims with existing ones
    const stripe_subs = existingClaims.stripe_subs || {};
    stripe_subs[subscription.id] = {
      // https://docs.stripe.com/api/subscriptions/object#subscription_object-status
      status: subscription.status,
      prods: products
    };
    /*
    {
      'stripe_subs': {
        // we need the sub id to be able to update it on subsequent webhooks
        'sub_1QuhibIz61apsROqSAQ1LoSU': {
          'status': 'trialing',
          'prods': ['1xprod_RaNeaDpniWdiK4']
        }
      }
    }
    */
    return {
      ...existingClaims,
      stripe_subs,
    };
  }
}