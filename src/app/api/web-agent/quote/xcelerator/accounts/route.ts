import { NextResponse, type NextRequest } from "next/server";
import { isXceleratorQuoteConfigured, searchXceleratorAccounts } from "@/lib/xcelerator-quote";

// Account search for the quote card: Xcelerator accounts whose company name
// or account number starts with what the CSR typed. Read-only.
export async function GET(request: NextRequest) {
  if (!isXceleratorQuoteConfigured()) {
    return NextResponse.json(
      { error: "Xcelerator's back office isn't connected (set XCELERATOR_BACKOFFICE_USERNAME and _PASSWORD)." },
      { status: 501 },
    );
  }
  const q = request.nextUrl.searchParams.get("q") ?? "";
  try {
    return NextResponse.json({ accounts: await searchXceleratorAccounts(q) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "no answer";
    return NextResponse.json({ error: `Xcelerator's account search failed (${message}).` }, { status: 502 });
  }
}
