import { handleMySoPrivateData } from "@/src/server/myso-private-data";

export const runtime = "nodejs";
export const POST = (request: Request) => handleMySoPrivateData(request, "publish-graph");
