import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Xcelerator Quote Agent",
  description: "Prices quote-request emails from Missive on the rate sheet and drafts the reply",
};

export default function QuoteAgentLayout({ children }: LayoutProps<"/quote-agent">) {
  return children;
}
