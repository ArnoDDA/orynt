export const sceneTitles = ['开场吸引', '展示产品', '收尾引导'];

export function defaultScenePlan(route = {}, claim = '') {
  return [
    { title: sceneTitles[0], text: route.hook || '先展示产品的使用场景。' },
    { title: sceneTitles[1], text: route.proof || claim || '用近景展示产品细节与使用过程。' },
    { title: sceneTitles[2], text: claim ? `产品与使用场景一起收尾，强调：${claim}。` : '以完整产品画面收尾，引导观众了解产品。' }
  ];
}

export function sceneTiming(duration = 15) {
  const seconds = Number(duration) === 30 ? 30 : 15;
  const cuts = [0, Math.round(seconds * .2), Math.round(seconds * .73), seconds];
  return sceneTitles.map((_, index) => ({ start: cuts[index], end: cuts[index + 1] }));
}
