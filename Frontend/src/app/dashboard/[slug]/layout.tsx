'use client';

import { useParams } from 'next/navigation';
import { StaffShell } from '@/components/staff';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  return <StaffShell slug={slug}>{children}</StaffShell>;
}
