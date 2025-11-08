import { PasswordGeneratorForm } from "@/components/PasswordGeneratorForm";

export default function Home() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-indigo-100 via-white to-sky-100 text-zinc-900 dark:from-zinc-950 dark:via-zinc-900 dark:to-indigo-950">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-indigo-300/40 blur-3xl dark:bg-indigo-700/30" />
        <div className="absolute bottom-0 right-12 h-80 w-80 rounded-full bg-sky-200/50 blur-3xl dark:bg-sky-800/30" />
      </div>
      <main className="relative mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6 py-16 sm:px-10 lg:px-16">
        <PasswordGeneratorForm />
      </main>
      <footer className="relative z-10 flex flex-col items-center gap-2 pb-10 text-sm text-zinc-600 dark:text-zinc-400">
        <a
          href="https://github.com/AIEpicStudio/password-tools"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-indigo-600 transition hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-200"
        >
          View source on GitHub
        </a>
        <p className="text-center text-xs">
          © {new Date().getFullYear()} Alejandro Castro &amp; AIEpicStudio.com. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
