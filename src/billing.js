const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRO_STATUSES = new Set(["active", "trialing"]);
const FREE_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired", "past_due", "paused"]);

function cleanSecret(value) {
  const text = String(value || "").trim();
  if (!text || /[\r\n]/.test(text) || text.length > 200) return "";
  return text;
}

export function publicBaseUrl(env) {
  try {
    const url = new URL(String(env.PUBLIC_BASE_URL || "").trim());
    if (url.username || url.password) return "";
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "http:" && !local) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function stripePriceId(env) {
  const price = String(env.STRIPE_PRICE_ID || "").trim();
  if (!/^price_[A-Za-z0-9_]+$/.test(price)) return "";
  return price;
}

export function checkoutConfig(env) {
  const base = publicBaseUrl(env);
  const price = stripePriceId(env);
  const secretKey = cleanSecret(env.STRIPE_SECRET_KEY);
  if (!base || !price || !/^sk_(test|live)_/.test(secretKey)) return null;
  return { base, price, secretKey };
}

export function webhookConfig(env) {
  const secretKey = cleanSecret(env.STRIPE_SECRET_KEY);
  const webhookSecret = cleanSecret(env.STRIPE_WEBHOOK_SECRET);
  if (!/^sk_(test|live)_/.test(secretKey) || webhookSecret.length < 16) return null;
  return { secretKey, webhookSecret };
}

export function isStripeRedirect(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && /(^|\.)stripe\.com$/.test(url.hostname);
  } catch {
    return false;
  }
}

function stripeId(value, prefix) {
  const text = typeof value === "string" ? value : value && typeof value.id === "string" ? value.id : "";
  if (!text || text.length > 80) return "";
  const pattern = new RegExp(`^${prefix}_[A-Za-z0-9]+$`);
  return pattern.test(text) ? text : "";
}

function userId(value) {
  return typeof value === "string" && USER_ID.test(value) ? value : "";
}

export function planForSubscriptionStatus(status) {
  if (PRO_STATUSES.has(status)) return "pro";
  if (FREE_STATUSES.has(status)) return "free";
  return null;
}

function metadataUserId(metadata) {
  if (!metadata || typeof metadata !== "object") return "";
  return userId(metadata.userId);
}

export function interpretStripeEvent(event) {
  if (!event || typeof event !== "object") return null;
  const obj = event.data?.object;
  if (!obj || typeof obj !== "object") return null;
  const type = event.type;

  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_failed") {
    const subscriptionMode = obj.mode === "subscription";
    let plan = null;
    if (subscriptionMode && type === "checkout.session.async_payment_failed") plan = "free";
    if (
      subscriptionMode &&
      type === "checkout.session.completed" &&
      (obj.payment_status === "paid" || obj.payment_status === "no_payment_required")
    ) {
      plan = "pro";
    }
    return {
      userId: userId(obj.client_reference_id) || metadataUserId(obj.metadata),
      customerId: stripeId(obj.customer, "cus"),
      subscriptionId: stripeId(obj.subscription, "sub"),
      plan,
    };
  }

  if (
    type === "customer.subscription.created" ||
    type === "customer.subscription.updated" ||
    type === "customer.subscription.deleted"
  ) {
    const status = type === "customer.subscription.deleted" ? "canceled" : obj.status;
    return {
      userId: metadataUserId(obj.metadata),
      customerId: stripeId(obj.customer, "cus"),
      subscriptionId: stripeId(obj.id, "sub"),
      plan: planForSubscriptionStatus(status),
    };
  }

  if (type === "invoice.payment_failed" || type === "invoice.paid" || type === "invoice.payment_succeeded") {
    const subscriptionId = stripeId(obj.subscription, "sub");
    if (!subscriptionId) return null;
    return {
      userId: metadataUserId(obj.metadata) || metadataUserId(obj.subscription_details?.metadata),
      customerId: stripeId(obj.customer, "cus"),
      subscriptionId,
      plan: type === "invoice.payment_failed" ? "free" : "pro",
    };
  }

  return null;
}

export function findBillingUser(users, change) {
  if (change.userId) {
    const byId = users.find((user) => user.id === change.userId);
    if (byId) return byId;
  }
  if (change.customerId) {
    const byCustomer = users.find((user) => user.stripeCustomerId === change.customerId);
    if (byCustomer) return byCustomer;
  }
  return null;
}

export function applyStripeEvent(state, event) {
  const change = interpretStripeEvent(event);
  if (!change || (!change.userId && !change.customerId)) return { applied: false };
  const user = findBillingUser(state.users, change);
  if (!user) return { applied: false };
  if (change.customerId) user.stripeCustomerId = change.customerId;
  if (change.subscriptionId) user.stripeSubscriptionId = change.subscriptionId;
  if (change.plan === "pro" || change.plan === "free") user.plan = change.plan;
  return { applied: true, userId: user.id, plan: user.plan };
}
