import { cn } from '@/lib/cn';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn('rounded-card border border-border bg-background p-6 shadow-sm', className)}
      {...props}
    />
  );
}
