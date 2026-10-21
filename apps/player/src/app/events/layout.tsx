import { FeatureGate } from '@/lib/feature-gate';

export default function ClubEventsLayout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="events">{children}</FeatureGate>;
}
