const POS_BIGRAM_BOOST: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  CC: {
    DT: 1.45,
    JJ: 1.25,
    NN: 1.35,
    NNS: 1.35,
    VB: 1.2,
    VBP: 1.2
  },
  DT: {
    JJ: 1.45,
    JJR: 1.3,
    JJS: 1.3,
    NN: 1.55,
    NNP: 1.35,
    NNS: 1.5
  },
  IN: {
    DT: 1.5,
    JJ: 1.2,
    NN: 1.3,
    NNP: 1.3,
    NNS: 1.3,
    PRP: 1.2
  },
  JJ: {
    JJ: 1.15,
    NN: 1.55,
    NNP: 1.25,
    NNS: 1.5
  },
  JJR: {
    NN: 1.45,
    NNS: 1.45
  },
  JJS: {
    NN: 1.45,
    NNS: 1.45
  },
  MD: {
    RB: 1.1,
    VB: 1.6
  },
  NN: {
    CC: 1.1,
    IN: 1.35,
    RB: 1.1,
    VBD: 1.35,
    VBP: 1.2,
    VBZ: 1.35
  },
  NNP: {
    CC: 1.1,
    IN: 1.25,
    VBD: 1.3,
    VBP: 1.15,
    VBZ: 1.3
  },
  NNS: {
    CC: 1.1,
    IN: 1.3,
    VBD: 1.3,
    VBP: 1.35,
    VBZ: 1.15
  },
  PRP: {
    MD: 1.2,
    RB: 1.1,
    VB: 1.15,
    VBD: 1.25,
    VBP: 1.35,
    VBZ: 1.25
  },
  PRP$: {
    JJ: 1.2,
    NN: 1.5,
    NNP: 1.25,
    NNS: 1.45
  },
  RB: {
    JJ: 1.2,
    VB: 1.1,
    VBD: 1.15,
    VBP: 1.15,
    VBZ: 1.2
  },
  TO: {
    RB: 1.05,
    VB: 1.65
  },
  VB: {
    DT: 1.35,
    IN: 1.2,
    JJ: 1.2,
    NN: 1.25,
    NNS: 1.25,
    RB: 1.25
  },
  VBD: {
    DT: 1.35,
    IN: 1.2,
    JJ: 1.2,
    NN: 1.25,
    NNS: 1.25,
    RB: 1.25
  },
  VBG: {
    DT: 1.25,
    IN: 1.15,
    JJ: 1.15,
    NN: 1.2,
    NNS: 1.2,
    RB: 1.2
  },
  VBN: {
    DT: 1.25,
    IN: 1.15,
    JJ: 1.15,
    NN: 1.2,
    NNS: 1.2,
    RB: 1.2
  },
  VBP: {
    DT: 1.35,
    IN: 1.2,
    JJ: 1.2,
    NN: 1.25,
    NNS: 1.25,
    RB: 1.25
  },
  VBZ: {
    DT: 1.35,
    IN: 1.2,
    JJ: 1.2,
    NN: 1.25,
    NNS: 1.25,
    RB: 1.25
  },
  WP: {
    MD: 1.1,
    VBZ: 1.5
  },
  WRB: {
    JJ: 1.1,
    VBZ: 1.45
  }
};

export function getPosBigramBoost(
  prefixPos: string | null,
  suffixPos: string | null
): number {
  if (!prefixPos || !suffixPos) {
    return 1;
  }

  return POS_BIGRAM_BOOST[prefixPos]?.[suffixPos] ?? 1;
}
