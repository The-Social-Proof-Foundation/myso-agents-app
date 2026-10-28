import { workPlanSchema, type ExecutionScope, type WorkPlan, type WorkRun } from "./contracts/work.ts";

export function validateWorkPlan(input: unknown): WorkPlan {
    const plan = workPlanSchema.parse(input);
    const byId = new Map(plan.steps.map((step) => [step.id, step]));
    if (byId.size !== plan.steps.length) throw new Error("Step ids must be unique");
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const walk = (id: string): void => {
        if (visited.has(id)) return;
        if (visiting.has(id)) throw new Error(`Work plan contains a cycle at ${id}`);
        const step = byId.get(id);
        if (!step) throw new Error(`Unknown prerequisite: ${id}`);
        if (new Set(step.dependsOn).size !== step.dependsOn.length) throw new Error(`Duplicate prerequisite on ${id}`);
        visiting.add(id);
        for (const prerequisite of step.dependsOn) walk(prerequisite);
        visiting.delete(id);
        visited.add(id);
    };
    for (const step of plan.steps) walk(step.id);
    return plan;
}
export function sameExecutionScope(a: ExecutionScope, b: ExecutionScope): boolean {
    const norm = (value?: string): string => value ? `0x${value.slice(2).toLowerCase().padStart(64, "0")}` : "";
    return a.network === b.network && (["owner", "accountId", "agentId", "organizationId", "platformId"] as const).every((key) => norm(a[key]) === norm(b[key]));
}
export function runnableSteps(run: WorkRun): string[] {
    if (run.status !== "running" && run.status !== "planned") return [];
    return run.plan.steps.filter((step) => (run.stepStatus[step.id] ?? "pending") === "pending" && step.dependsOn.every((id) => run.stepStatus[id] === "succeeded")).map((step) => step.id);
}
