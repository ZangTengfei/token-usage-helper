import { CLIENTS } from "./analytics.mjs";

const colors = [
  "#198664",
  "#3576b7",
  "#ce7a26",
  "#8266b4",
  "#268698",
  "#b45078",
  "#748747",
  "#82909a",
];
const short = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const hourFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const left = 63,
  right = 740,
  top = 20,
  bottom = 183;
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function chart(host, name) {
  const root = svg("svg", {
    viewBox: "0 0 800 217",
    role: "group",
    "aria-label": name,
  });
  host.replaceChildren(root);
  return root;
}
function axis(root, max, dual = false) {
  for (let i = 0; i <= 4; i++) {
    const y = bottom - (i * (bottom - top)) / 4;
    root.append(
      svg("line", {
        x1: left,
        x2: right,
        y1: y,
        y2: y,
        stroke: "#dfe6e3",
        "stroke-dasharray": "3 4",
      }),
    );
    label(
      root,
      left - 8,
      y + 4,
      dual ? i * 25 + "%" : short.format((max * i) / 4),
      "end",
    );
    if (dual)
      label(root, right + 8, y + 4, short.format((max * i) / 4), "start");
  }
}
function label(root, x, y, text, anchor = "middle") {
  root.append(
    svg(
      "text",
      { x, y, "text-anchor": anchor, fill: "#53645f", "font-size": 12 },
      text,
    ),
  );
}
function pointInfo(node, text) {
  node.setAttribute("aria-label", text);
  node.append(svg("title", {}, text));
}
function legend(host, names) {
  host.replaceChildren(
    ...names.map(([name, color]) => {
      const item = document.createElement("span"),
        dot = document.createElement("i");
      dot.style.backgroundColor = color;
      item.append(dot, document.createTextNode(name));
      return item;
    }),
  );
}
export function dailyChart(report, dimension, selectDay) {
  const host = document.getElementById("daily-stack");
  const key = dimension === "model" ? "models" : "tools";
  const series = report[key].filter((r) => r.tokens > 0);
  const named = series.slice(0, series.length > 8 ? 7 : 8);
  const names = named.map((r) =>
    key === "tools" ? CLIENTS[r.name] || r.name : r.name,
  );
  if (series.length > 8) names.push("其他");
  legend(
    document.getElementById("daily-stack-legend"),
    names.map((n, i) => [n, colors[i]]),
  );
  if (!series.length) {
    host.textContent = "当前范围暂无用量。";
    return;
  }
  const root = chart(host, "每日 Token 用量"),
    max = Math.max(...report.days.map((d) => d.total)),
    step = (right - left) / report.days.length;
  axis(root, max);
  const indexes = new Map(named.map((r, i) => [r.name, i]));
  report.days.forEach((day, i) => {
    const values = names.map(() => 0);
    for (const row of day[key])
      if (row.tokens) values[indexes.get(row.name) ?? 7] += row.tokens;
    const x = left + (i + 0.5) * step;
    let y = bottom;
    const group = svg("g", { tabindex: 0, role: "button" });
    pointInfo(
      group,
      [
        day.date,
        day.known ? day.total.toLocaleString() + " Token" : "无记录",
        ...values.flatMap((n, j) =>
          n ? [names[j] + " " + n.toLocaleString()] : [],
        ),
      ].join(" · "),
    );
    group.append(
      svg("rect", {
        x: x - step / 2,
        y: top,
        width: step,
        height: bottom - top,
        fill: "transparent",
      }),
    );
    values.forEach((n, j) => {
      if (!n) return;
      const h = ((bottom - top) * n) / max;
      y -= h;
      group.append(
        svg("rect", {
          x: x - step * 0.39,
          y,
          width: step * 0.78,
          height: h,
          fill: colors[j],
        }),
      );
    });
    group.onclick = () => selectDay(day.date);
    group.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectDay(day.date);
      }
    };
    root.append(group);
    if (
      i === report.days.length - 1 ||
      (i % Math.ceil(report.days.length / 6) === 0 &&
        report.days.length - 1 - i >= Math.ceil(report.days.length / 12))
    )
      label(root, x, bottom + 22, day.date.slice(5));
  });
}
export function hourlyChart(hours) {
  const host = document.getElementById("hourly-plot");
  if (!hours.some((h) => h.total > 0)) {
    host.textContent = "近 24 小时暂无已记录的用量。";
    return;
  }
  const root = chart(host, "近 24 小时 Token 用量和缓存命中率"),
    max = Math.max(1, ...hours.map((h) => h.total));
  axis(root, max, true);
  const x = (i) => left + (i * (right - left)) / 23;
  for (const [field, color, scale] of [
    ["total", "#c57a18", max],
    ["rate", "#2876c2", 1],
  ]) {
    let path = "",
      last = false;
    hours.forEach((h, i) => {
      if (h[field] === null) {
        last = false;
        return;
      }
      const y = bottom - ((bottom - top) * h[field]) / scale;
      path += (last ? " L" : " M") + x(i) + " " + y;
      last = true;
    });
    root.append(
      svg("path", {
        d: path.trim(),
        stroke: color,
        fill: "none",
        "stroke-width": 2.5,
      }),
    );
    hours.forEach((h, i) => {
      if (h[field] === null) return;
      const dot = svg("circle", {
        cx: x(i),
        cy: bottom - ((bottom - top) * h[field]) / scale,
        r: 3,
        fill: color,
      });
      root.append(dot);
    });
  }
  hours.forEach((h, i) => {
    const time = hourFormat.format(h.time);
    if (i % 4 === 0 || i === 23) label(root, x(i), bottom + 22, time);
    const hit = svg("rect", {
      x: x(i) - 10,
      y: top,
      width: 20,
      height: bottom - top,
      fill: "transparent",
      tabindex: 0,
    });
    pointInfo(
      hit,
      time +
        " · " +
        h.total.toLocaleString() +
        " Token · 缓存命中率 " +
        (h.rate === null ? "无数据" : (100 * h.rate).toFixed(1) + "%"),
    );
    root.append(hit);
  });
}
