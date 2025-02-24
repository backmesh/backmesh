import Stripe from "stripe";
import { AuthProviderType, CustomClaims, StripeSubscriptions, StripeIntegration } from "./repos/models";
import Firebase from "./gateways/firebase";

async function getClaims(uid: string, integration: StripeIntegration): Promise<CustomClaims> {
  if (integration.authType === AuthProviderType.FIREBASE) {
    return await Firebase.Admin.getClaims(integration.authPrivateKey, uid);
  } else if (integration.authType === AuthProviderType.SUPABASE) {
    throw new TypeError("Supabase not supported");
  } else {
    throw new TypeError("Unsupported auth provider");
  }
}

async function setClaims(uid: string, integration: StripeIntegration, claims: CustomClaims) {
  if (integration.authType === AuthProviderType.FIREBASE) {
    return await Firebase.Admin.setClaims(integration.authPrivateKey, uid, claims);
  } else if (integration.authType === AuthProviderType.SUPABASE) {
    throw new TypeError("Supabase not supported");
  }
}

// TODO remove cancelled subscriptions to save space?
// exported for testing only
export function updateClaims(existingClaims: CustomClaims, subscription: Stripe.Subscription): CustomClaims {
  const products = subscription.items.data.map(item => `${item.quantity}x${item.price.product}`);
  // Merge new claims with existing ones
  const stripe_subs: StripeSubscriptions = existingClaims.stripe_subs || {};
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

// exported for testing only
export function hasValidSubscription(claims: CustomClaims) {
  const stripeSubs: StripeSubscriptions = claims['stripe_subs'];
  if (!stripeSubs) return false;
  for (const stripeSubId of Object.keys(stripeSubs)) {
    const stripeSub = stripeSubs[stripeSubId];
    if (stripeSub !== undefined && (stripeSub.status === 'active' || stripeSub.status === 'trialing')) {
      return true;
    }
  }
  return false;
}

export default {
  async getAll(serviceAccount: string, integration: StripeIntegration) {
    if (integration.authType === AuthProviderType.FIREBASE) {
      return await Firebase.Admin.getAllUsersClaims(serviceAccount);
    } else if (integration.authType === AuthProviderType.SUPABASE) {
      throw new TypeError("Supabase not supported");
    }
  },
  async save(uid: string, integration: StripeIntegration, subscription: Stripe.Subscription) {
    const claims = await getClaims(uid, integration);
    const updatedClaims = updateClaims(claims, subscription);
    await setClaims(uid, integration, updatedClaims);
  },
  Backmesh: {
    async save(serviceAccount: string, uid: string, subscription: Stripe.Subscription) {
      const claims = await Firebase.Admin.getClaims(serviceAccount, uid);
      const updatedClaims = updateClaims(claims, subscription);
      await Firebase.Admin.setClaims(serviceAccount, uid, updatedClaims);
    },
    async isValid(firebaseKey: string, backmeshUserJwt: string) {
      const claims = await Firebase.getClaims(backmeshUserJwt, firebaseKey);
      return hasValidSubscription(claims);
    }
  }
}