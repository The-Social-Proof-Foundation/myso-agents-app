import { handleMySoPrivateData } from "@/src/server/myso-private-data";
export async function POST(request:Request){return handleMySoPrivateData(request,"graph-item");}
