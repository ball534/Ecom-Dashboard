// api/_error.js
// The single error type every Shopify call path throws. It lives in its own module
// so api/_token.js (which mints access tokens) and api/_shopify.js (which spends
// them) can both use it without importing each other in a cycle.

export class ShopifyError extends Error {
  constructor(reason, message, status) {
    super(message || reason);
    this.name = "ShopifyError";
    // no-token | no-domain | auth | scope | throttle | http | graphql | timeout
    this.reason = reason;
    this.status = status;
  }
}
