type Props = {
  title: string;
  description?: string;
  /** Small pill shown next to the title, e.g. "Beta". */
  badge?: string;
};

export function SectionHeader({ title, description, badge }: Props) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h1 className="text-[18px] font-semibold tracking-tight">{title}</h1>
        {badge ? (
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
            {badge}
          </span>
        ) : null}
      </div>
      {description ? (
        <p className="text-[12px] text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
