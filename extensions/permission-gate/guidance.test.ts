import { describe, expect, it } from "vitest";
import {
  consumeApproval,
  extractApprovalId,
  GUIDANCE_MARKER_PREFIX,
  issueApproval,
} from "./guidance";

describe("guidance approval store", () => {
  it("issues an id that approves the exact command once", () => {
    const command = "git push --force";
    const id = issueApproval(command);

    expect(consumeApproval(command, id)).toBe(true);
    // single-use: a second consume fails
    expect(consumeApproval(command, id)).toBe(false);
  });

  it("rejects an id issued for a different command", () => {
    const id = issueApproval("git push --force");
    expect(consumeApproval("git push", id)).toBe(false);
    // and the id is still unconsumed for the right command
    expect(consumeApproval("git push --force", id)).toBe(true);
  });

  it("rejects unknown ids", () => {
    expect(consumeApproval("anything", "does-not-exist")).toBe(false);
  });
});

describe("extractApprovalId", () => {
  it("extracts the id from a trailing marker", () => {
    const command = `git push --force ${GUIDANCE_MARKER_PREFIX}abc-123`;
    expect(extractApprovalId(command)).toBe("abc-123");
  });

  it("returns null when no marker is present", () => {
    expect(extractApprovalId("git push --force")).toBeNull();
  });

  it("ignores a bare marker with no id", () => {
    expect(extractApprovalId(`git push ${GUIDANCE_MARKER_PREFIX}`)).toBeNull();
  });
});
