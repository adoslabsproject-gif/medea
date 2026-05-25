import type { SelectHTMLAttributes, ReactNode } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectOptionGroup {
  label: string;
  options: SelectOption[];
}

export type SelectItem = SelectOption | SelectOptionGroup;

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  hint?: string;
  errorMessage?: string;
  size?: 'sm' | 'md' | 'lg';
  items: SelectItem[];
  placeholder?: string;
  startSlot?: ReactNode;
  fullWidth?: boolean;
}
