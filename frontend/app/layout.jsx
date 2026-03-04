import { Manrope, Sora } from "next/font/google";
import "./globals.css";
import Providers from "./providers";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
});

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-display",
});

export const metadata = {
  title: "Acta de Visita | Mundo Ocupacional",
  description: "Formulario digital de actas de visita",
  icons: {
    icon: "/img/logo-claro.png",
    shortcut: "/img/logo-claro.png",
    apple: "/img/logo-claro.png",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body className={`${manrope.variable} ${sora.variable}`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
