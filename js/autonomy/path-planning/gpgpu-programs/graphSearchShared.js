const SHARED = `

const float smallV = 0.01;
vec4 pathSamples[128];
float pathSampleCurvRates[128];

float calculateAcceleration(int index, float initialVelocitySq, float distance) {
  if (index <= 4) {
    // [aMaxHard, aMinHard, aMaxSoft, aMinSoft, 0]
    return accelerationProfiles[index];
  } else {
    float finalVelocity = finalVelocityProfiles[index - 5];
    return clamp((finalVelocity * finalVelocity - initialVelocitySq) / (2.0 * distance), accelerationProfiles[1], accelerationProfiles[0]);
  }
}

float sampleStaticCost(vec4 xytk) {
  vec2 xyTexCoords = (xytk.xy - xyCenterPoint) / vec2(textureSize(xyslMap, 0)) / vec2(xyGridCellSize) + 0.5;
  vec2 sl = texture(xyslMap, xyTexCoords).xy;

  vec2 slTexCoords = (sl - slCenterPoint) / vec2(textureSize(slObstacleGrid, 0)) / vec2(slGridCellSize) + 0.5;
  float obstacleCost = texture(slObstacleGrid, slTexCoords).x;

  if (obstacleCost == 1.0) return -1.0; // Infinite cost
  obstacleCost = step(0.25, obstacleCost) * obstacleHazardCost;

  float absLatitude = abs(sl.y);
  float laneCost = max(absLatitude * laneCostSlope, step(laneShoulderLatitude, absLatitude) * laneShoulderCost);

  return obstacleCost + laneCost;
}

float sampleDynamicCost(vec4 xytk, float time, float velocity, float acceleration) {
  return 1.0;
}

float calculateStaticCostSum(int numSamples) {
  float staticCostSum = 0.0;

  for (int i = 0; i < numSamples; i++) {
    float cost = sampleStaticCost(pathSamples[i]);

    if (cost < 0.0) return cost;

    staticCostSum += cost;
  }

  return staticCostSum;
}

float calculateDynamicCostSum(int numSamples, float pathLength, float initialVelocity, float acceleration) {
  float s = 0.0;
  float ds = pathLength / float(numSamples - 1);
  float dynamicCostSum = 0.0;
  float maxVelocity = 0.0;
  float maxLateralAcceleration = 0.0;

  for (int i = 0; i < numSamples; i++) {
    vec4 pathSample = pathSamples[i]; // vec4(x-pos, y-pos, theta (rotation), kappa (curvature))

    float velocitySq = 2.0 * acceleration * s + initialVelocity * initialVelocity;
    float velocity = max(smallV, sqrt(max(0.0, velocitySq)));
    maxVelocity = max(maxVelocity, velocity);
    maxLateralAcceleration = max(maxLateralAcceleration, abs(pathSample.w * velocity * velocity));

    float time = 2.0 * s / (initialVelocity + velocity);

    float dCurv = pathSampleCurvRates[i] * velocity;
    if (dCurv > dCurvatureMax) return -1.0;

    float cost = sampleDynamicCost(pathSample, time, velocity, acceleration);
    if (cost < 0.0) return cost;

    dynamicCostSum += cost;
    s += ds;
  }

  // Apply speeding penality if any velocity along the trajectory is over the speed limit
  dynamicCostSum += step(speedLimit, maxVelocity) * speedLimitPenalty;

  // Apply hard acceleration/deceleration penalties if the acceleration/deceleration exceeds the soft limits
  dynamicCostSum += step(accelerationProfiles[2] + 0.0001, acceleration) * hardAccelerationPenalty;
  dynamicCostSum += (1.0 - step(accelerationProfiles[3], acceleration)) * hardDecelerationPenalty;

  // Penalize lateral acceleration
  dynamicCostSum += step(lateralAccelerationLimit, maxLateralAcceleration) * softLateralAccelerationPenalty;
  dynamicCostSum += linearLateralAccelerationPenalty * maxLateralAcceleration;

  return dynamicCostSum;
}

`;

const SAMPLE_CUBIC_PATH_FN = `

int sampleCubicPath(vec4 start, vec4 end, vec4 cubicPathParams) {
  float p0 = start.w;
  float p1 = cubicPathParams.x;
  float p2 = cubicPathParams.y;
  float p3 = end.w;
  float sG = cubicPathParams.z;

  int numSamples = int(ceil(sG / pathSamplingStep)) + 1;

  float sG_2 = sG * sG;
  float sG_3 = sG_2 * sG;

  float a = p0;
  float b = (-5.5 * p0 + 9.0 * p1 - 4.5 * p2 + p3) / sG;
  float c = (9.0 * p0 - 22.5 * p1 + 18.0 * p2 - 4.5 * p3) / sG_2;
  float d = (-4.5 * (p0 - 3.0 * p1 + 3.0 * p2 - p3)) / sG_3;

  pathSamples[0] = start;

  float ds = sG / float(numSamples - 1);
  float s = ds;
  vec2 dxy = vec2(0);
  vec2 prevCosSin = vec2(cos(start.z), sin(start.z));

  for (int i = 1; i < numSamples; i++) {
    float rot = (((d * s / 4.0 + c / 3.0) * s + b / 2.0) * s + a) * s + start.z;
    float curv = ((d * s + c) * s + b) * s + a;

    vec2 cosSin = vec2(cos(rot), sin(rot));
    dxy = dxy * vec2(float(i - 1) / float(i)) + (cosSin + prevCosSin) / vec2(2 * i);

    pathSamples[i] = vec4(dxy * vec2(s) + start.xy, rot, curv);
    pathSampleCurvRates[i] = b + s * (2.0 * c + 3.0 * d * s);

    s += ds;
    prevCosSin = cosSin;
  }

  return numSamples;
}

`;

const SAMPLE_QUINTIC_PATH_FN = `

int sampleQuinticPath(vec4 start, vec4 end, vec4 quinticPathParams) {
  float p0 = start.w;
  float p1 = dCurvVehicle;
  float p2 = ddCurvVehicle;
  float p3 = quinticPathParams.x;
  float p4 = quinticPathParams.y;
  float p5 = end.w;
  float sG = quinticPathParams.z;

  int numSamples = int(ceil(sG / pathSamplingStep)) + 1;

  float sG_2 = sG * sG;
  float sG_3 = sG_2 * sG;

  float a = p0;
  float b = p1;
  float c = p2 / 2.0;
  float d = (-71.875 * p0 + 81.0 * p3 - 10.125 * p4 + p5 - 21.25 * p1 * sG - 2.75 * p2 * sG_2) / sG_3;
  float e = (166.5 * p0 - 202.5 * p3 + 40.5 * p4 - 4.5 * p5 + 45.0 * p1 * sG + 4.5 * p2 * sG_2) / (sG_2 * sG_2);
  float f = (-95.625 * p0 + 121.5 * p3 - 30.375 * p4 + 4.5 * p5 - 24.75 * p1 * sG - 2.25 * p2 * sG_2) / (sG_2 * sG_3);

  pathSamples[0] = start;

  float ds = sG / float(numSamples - 1);
  float s = ds;
  vec2 dxy = vec2(0);
  vec2 prevCosSin = vec2(cos(start.z), sin(start.z));

  for (int i = 1; i < numSamples; i++) {
    float rot = (((((f * s / 6.0 + e / 5.0) * s + d / 4.0) * s + c / 3.0) * s + b / 2.0) * s + a) * s + start.z;
    float curv = ((((f * s + e) * s + d) * s + c) * s + b) * s + a;

    vec2 cosSin = vec2(cos(rot), sin(rot));
    dxy = dxy * vec2(float(i - 1) / float(i)) + (cosSin + prevCosSin) / vec2(2 * i);

    pathSamples[i] = vec4(dxy * vec2(s) + start.xy, rot, curv);
    pathSampleCurvRates[i] = b + s * (2.0 * c + s * (3.0 * d + s * (4.0 * e + 5.0 * f * s)));

    s += ds;
    prevCosSin = cosSin;
  }

  return numSamples;
}

`;


export { SHARED, SAMPLE_CUBIC_PATH_FN, SAMPLE_QUINTIC_PATH_FN }
