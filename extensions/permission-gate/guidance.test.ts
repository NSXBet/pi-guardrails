import { describe, expect, it } from "vitest";
import { consumeApproval, issueApproval } from "./guidance";

describe("guidance approval store", () => {
  it("issues an id and consumes it returning the stored command", () => {
    const command = "git stash list";
    const id = issueApproval(command);
    expect(consumeApproval(id)).toBe(command);
  });

  it("is single-use: second consume returns null", () => {
    const id = issueApproval("git stash list");
    consumeApproval(id);
    expect(consumeApproval(id)).toBeNull();
  });

  it("returns null for unknown ids", () => {
    expect(consumeApproval("does-not-exist")).toBeNull();
  });

  it("stores different commands independently", () => {
    const id1 = issueApproval("git stash list");
    const id2 = issueApproval("git stash drop");
    expect(consumeApproval(id2)).toBe("git stash drop");
    expect(consumeApproval(id1)).toBe("git stash list");
  });
});
