import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUniqueViolation, publicErrorMessage } from "./publicError.js";

describe("public error text", () => {
  it("returns the real message instead of Internal Server Error", () => {
    assert.equal(
      publicErrorMessage({ message: "Unique constraint failed on (caseId, sha256)" }, 500),
      "Unique constraint failed on (caseId, sha256)",
    );
  });

  it("keeps a connection string out of the message", () => {
    const text = publicErrorMessage(
      { message: "Can't reach postgres://user:secret@db.internal:5432/app" },
      500,
    );
    assert.equal(text.includes("secret"), false);
    assert.match(text, /postgres:\/\/…/);
  });

  it("recognises a Prisma unique violation", () => {
    assert.equal(isUniqueViolation({ code: "P2002" }), true);
    assert.equal(isUniqueViolation(new Error("no")), false);
  });
});
