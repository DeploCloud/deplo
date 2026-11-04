// Only seen before a route's own loading state arrives: a shape here would belong to no page.
export default function Loading() {
  return <div aria-busy className="min-h-[50vh]" />;
}
