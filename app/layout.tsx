import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agentic Control Freak",
  description: "A web chat control plane for durable coding-agent workflows.",
};

const themeBootstrap = `(function(){try{var m=localStorage.getItem('cdl.theme');var s=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';var t=(m==='light'||m==='dark')?m:s;document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
