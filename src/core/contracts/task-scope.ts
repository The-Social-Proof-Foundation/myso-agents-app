import { z } from "zod";

/** Versioned private scope sent through a task's encrypted agent room. */
export const mySoTaskScopeSchema = z.object({
    type: z.literal("myso.task.scope.v1"),
    version: z.literal(1),
    title: z.string().trim().min(1).max(256),
    scope: z.string().trim().min(1).max(12000),
    acceptanceCriteria: z.string().trim().min(1).max(4000),
}).strict();

export type MySoTaskScope = z.infer<typeof mySoTaskScopeSchema>;
