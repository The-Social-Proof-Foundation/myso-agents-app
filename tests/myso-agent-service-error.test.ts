import assert from "node:assert/strict";
import { test } from "node:test";
import { MySoAgentServiceError, MySoMcpClient } from "../src/server/integrations/myso-mcp.ts";
import { mySoErrorResponse } from "../src/server/myso-auth.ts";

test("a 404 from the agent service is shown as that status", async () => {
    const client = new MySoMcpClient("https://agents.example", "token", async () => new Response(null, { status: 404 }));
    await assert.rejects(() => client.callTool("agent_get_context", {}), (error: unknown) => {
        assert.ok(error instanceof MySoAgentServiceError);
        assert.equal(error.status, 404);
        assert.equal(error.message, "The agent service returned 404");
        return true;
    });
    const response = mySoErrorResponse(new MySoAgentServiceError(404));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "The agent service returned 404" });
});
