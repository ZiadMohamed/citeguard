import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isQuoteGrounded } from "./quote.js";

const source = `Mean body weight gain was reduced by 12.3% in the high-dose group (p < 0.05). No deaths occurred.`;

describe("isQuoteGrounded", () => {
  it("accepts exact and lightly reformatted quotes", () => {
    assert.equal(isQuoteGrounded("reduced by 12.3% in the high-dose group", source), true);
    assert.equal(isQuoteGrounded("  Reduced BY 12.3%   in the high-dose group.", source), true);
  });

  it("rejects altered numbers", () => {
    assert.equal(isQuoteGrounded("reduced by 13.2% in the high-dose group", source), false);
    assert.equal(isQuoteGrounded("reduced by 123% in the high-dose group", source), false);
  });

  it("handles ellipses as in-order gaps", () => {
    assert.equal(isQuoteGrounded("Mean body weight ... No deaths occurred", source), true);
    assert.equal(isQuoteGrounded("No deaths occurred ... Mean body weight", source), false);
  });

  it("rejects empty quotes", () => {
    assert.equal(isQuoteGrounded("", source), false);
  });
});
