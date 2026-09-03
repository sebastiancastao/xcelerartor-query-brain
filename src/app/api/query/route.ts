import { NextResponse } from "next/server";
import {
  answerOrderQuestion,
  getCompletedOrdersForPeriod,
  OrderQueryError,
} from "@/lib/order-query";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const question = body?.question;
  const startDate = body?.startDate;
  const endDate = body?.endDate;

  try {
    if (typeof startDate === "string" && typeof endDate === "string") {
      const result = await getCompletedOrdersForPeriod(startDate, endDate);
      return NextResponse.json(result);
    }

    if (typeof question !== "string" || !question.trim()) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    const result = await answerOrderQuestion(question);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to answer question";
    const status = err instanceof OrderQueryError ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
