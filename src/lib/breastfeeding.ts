/**
 * Cue-based breastfeeding guidance.
 *
 * This module deliberately does not expose age-band schedules, feed quotas, or
 * next-feed calculators. It supports recording context while leaving individual
 * feeding plans to the baby's clinician and feeding professional.
 */

export interface BilingualGuidance {
  ko: string
  ja: string
}

export const BF_RESPONSIVE_GUIDANCE: BilingualGuidance = {
  ko: '시계보다 아기의 배고픔 신호(입을 오물거리기, 손 빨기, 고개 돌려 찾기)와 포만 신호(빨기 멈추기, 고개 돌리기, 몸이 편안해지기)를 살피며 반응해요.',
  ja: '時計より、赤ちゃんの空腹サイン（口をもぐもぐする、手を吸う、顔を向けて探す）と満腹サイン（吸うのをやめる、顔をそむける、体が落ち着く）を見て応じます。',
}

export const BF_NEWBORN_GUIDANCE: BilingualGuidance = {
  ko: '신생아는 자주 먹는 것이 흔해요. 깨우기 어렵거나 잘 먹지 못하고, 소변이 줄거나 체중 증가가 걱정되면 수유 전문가나 의료진에게 바로 확인하세요.',
  ja: '新生児は頻繁に飲むことがよくあります。起こしにくい、うまく飲めない、尿が減る、体重増加が心配な場合は、授乳の専門家や医療者にすぐ確認してください。',
}

export const BF_CLUSTER_NOTE: BilingualGuidance = {
  ko: '짧은 간격으로 이어 먹는 양상은 흔할 수 있어요. 다만 잘 먹지 못함, 소변 감소, 처짐이나 체중 증가 우려가 함께 있으면 의료진에게 확인하세요.',
  ja: '短い間隔で続けて飲むことはよくあります。ただし、うまく飲めない、尿の減少、ぐったり、体重増加への心配があれば医療者に確認してください。',
}

export const BF_DISCLAIMER: BilingualGuidance = {
  ko: '이 화면은 수유 기록을 이해하기 위한 일반 정보이며 개인별 진료나 수유 계획을 대신하지 않아요.',
  ja: 'この画面は授乳記録を理解するための一般情報であり、個別の診療や授乳計画に代わるものではありません。',
}
