export function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-edge bg-panel">
      <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3">
        <div>
          <h2 className="text-[13px] font-semibold text-mut">{title}</h2>
          {hint ? <p className="mt-0.5 text-[12px] text-mut/80">{hint}</p> : null}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
