import assert from "node:assert/strict";
import test from "node:test";
import { myDataContentRequestSchema, myDataQuoteSchema } from "../src/core/contracts/mydata.ts";

test("private content requests pin exact ciphertext and bounded, explicit page units",()=>{
    const valid={mydataId:"0x1",encryptedDataDigestHex:"a".repeat(64),format:"utf8",offset:0,limit:4000};
    assert.equal(myDataContentRequestSchema.safeParse(valid).success,true);
    for(const changed of [{limit:0},{limit:8001},{offset:-1},{offset:262145},{encryptedDataDigestHex:"unknown"},{mydataId:"https://example.com"},{session:"secret"}]){
        assert.equal(myDataContentRequestSchema.safeParse({...valid,...changed}).success,false);
    }
});
test("quotes preserve exact u64 money and reject floating-point amounts",()=>{
    const valid={mydataId:"0x1",buyerAddress:"0x2",objectVersion:"9007199254740993",deploymentEnabled:false,
        purchaseParameters:{mydataId:"0x1",expectedSeller:"0x3",accessKind:3,priceMist:"18446744073709551615",durationDays:"730",encryptionIdHex:"abcd",encryptedDataDigestHex:"a".repeat(64)}};
    assert.equal(myDataQuoteSchema.parse(valid).purchaseParameters.priceMist,"18446744073709551615");
    for(const priceMist of [1.1,9007199254740992,"18446744073709551616","01"]){assert.equal(myDataQuoteSchema.safeParse({...valid,purchaseParameters:{...valid.purchaseParameters,priceMist}}).success,false);}
});
