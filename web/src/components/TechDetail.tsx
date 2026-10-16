/** Technical detail of a service check for administrators (e.g. «HTTP 503»), as small secondary text. */
export function TechDetail(props: { detail: string | null }) {
  if (!props.detail) return null;
  return <p class="tech-detail">Подробности: {props.detail}</p>;
}
