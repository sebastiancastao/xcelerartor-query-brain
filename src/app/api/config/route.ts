import { NextResponse } from "next/server";
import { isXceleratorConfigured } from "@/lib/xcelerator";
import { isOpenAIConfigured } from "@/lib/openai";
import { isMissiveConfigured } from "@/lib/missive";
import { isQuoteEngineConfigured } from "@/lib/quote-engine";

export async function GET() {
  return NextResponse.json({
    live: isXceleratorConfigured(),
    aiDrafting: isOpenAIConfigured(),
    missiveConfigured: isMissiveConfigured(),
    quoteEngine: isQuoteEngineConfigured(),
  });
}
