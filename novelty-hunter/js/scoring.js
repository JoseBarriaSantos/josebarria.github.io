function sumMoveGames(moveInfo) {
  return moveInfo.white + moveInfo.black + moveInfo.draws;
}

function computeMoveFreq(moveInfo, mostPlayedMove) { // done to give more rarity to a scenario of 0/1000 than 0/1
  return sumMoveGames(moveInfo) != 0 ? sumMoveGames(moveInfo) / sumMoveGames(mostPlayedMove) : 1 / sumMoveGames(mostPlayedMove);
}

function computeRarityScore(frequency, followUpGames,
                            threshold) {

  // followUpScore: fewer follow-up games = rarer = higher
  const followUpScore = Math.min(0.2, 1 / followUpGames);

  // frequencyScore: lower frequency = rarer = higher
  const frequencyScore = 1 - (frequency / threshold);

  return Math.max(0, Math.min(1, Math.round((followUpScore + frequencyScore) * 1000) / 1000));
}

function computeEarlyNovScore(moveThreshold, moveNumber, maxMove = 15) {
  if (moveNumber <= moveThreshold) return 1;
  if (moveNumber >= maxMove) return 0;
  return (maxMove - moveNumber) / (maxMove - moveThreshold);
}

function computeResultScore(result, whiteToMove) {
  // bounded [-1, +1]
  let score = 0;
  if (whiteToMove) {
    if (result === "1-0")       score = 0.5;
    else if (result === "0-1")  score = -1;
    else if (result === "1/2-1/2") score = -0.25;
  } else {
    if (result === "0-1")       score = 1;
    else if (result === "1-0")  score = -0.5;
    else if (result === "1/2-1/2") score = 0.25;
  }
  return score;
}

function computeEfficiencyScore(result, whiteToMove, stockfishScore = null) {
  const resultScore = computeResultScore(result, whiteToMove);

  if (stockfishScore === null) {
    return Math.round(resultScore * 1000) / 1000;
  }

  const normalizedStockfish = Math.max(-1, Math.min(1, stockfishScore / 2));
  return Math.max(-1, Math.min(1, Math.round((normalizedStockfish + 0.2 * resultScore) * 1000) / 1000));
}

function computeInterestScore(rarityScore, efficiencyScore, earlyNovScore) {
  const score = 0.40*earlyNovScore + 0.40*efficiencyScore + 0.20*rarityScore;
  return Math.round(Math.max(0.0, Math.min(1.0, score)) * 1000) / 1000;
}

function isRare(moveSan, movesData,
                threshold, minGames, maxGames) {
  const movesDict = {};
  for (const m of movesData.moves) movesDict[m.san] = m;

  const moveInfo     = movesDict[moveSan] || null;
  const pmTotalGames = sumMoveGames(movesData.moves[0]);
  const followUpGames = moveInfo ? sumMoveGames(moveInfo) : 0;
  const frequency    = moveInfo ? computeMoveFreq(moveInfo, movesData.moves[0]) : 0.0;

  if (pmTotalGames <= minGames || followUpGames >= maxGames) return false;
  if (frequency === 0.0) return true;
  return frequency < threshold;
} 

function getAllMoveInfo(moveSan, movesData, moveNumber, result, whiteToMove,
                       stockfishScore = null,
                       threshold = 0.1,
                       moveThreshold = 5) {
  const gamesBefore = movesData['white'] + movesData['draws'] + movesData['black'];
  const movesDict = {};
  for (const m of movesData.moves) movesDict[m.san] = m;

  const moveInfo = movesDict[moveSan] || null;
  let frequency, followUpGames;
  if (!moveInfo) {
    frequency = movesData.moves.length > 0 ? 1 / sumMoveGames(movesData.moves[0]) : 0.0;
    followUpGames = 0;
  } else {
    frequency = computeMoveFreq(moveInfo, movesData.moves[0]);
    followUpGames = sumMoveGames(moveInfo);
  }

  const rarityScore     = computeRarityScore(frequency,
                                             followUpGames, threshold);
  const resultScore     = computeResultScore(result, whiteToMove);
  const efficiencyScore = computeEfficiencyScore(result, whiteToMove, stockfishScore);
  const earlyNovScore    = computeEarlyNovScore(moveThreshold, moveNumber)
  const interestScore   = computeInterestScore(rarityScore, efficiencyScore, earlyNovScore);

  return { frequency, followUpGames, gamesBefore, rarityScore, resultScore, efficiencyScore, earlyNovScore, interestScore, stockfishScore };
}
