import { NextResponse } from "next/server";
import { isXceleratorConfigured } from "@/lib/xcelerator";
import { isOpenAIConfigured } from "@/lib/openai";

export async function GET() {
  return NextResponse.json({
    live: isXceleratorConfigured(),
    aiDrafting: isOpenAIConfigured(),
  });
}
