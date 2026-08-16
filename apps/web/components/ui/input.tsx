import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export function Label(props: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return <label {...props} className={cn('mb-1.5 block text-sm font-medium text-foreground', props.className)} />;
}

export function FieldError({ children }: { children?: string }): React.JSX.Element | null {
  if (!children) return null;
  return (
    <p role="alert" className="mt-1.5 text-sm text-danger">
      {children}
    </p>
  );
}
