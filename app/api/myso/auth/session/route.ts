import { establishMySoSession } from "@/src/server/myso";

export async function POST(request: Request) {
    return establishMySoSession(request);
}
