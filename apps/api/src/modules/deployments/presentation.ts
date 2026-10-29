import type { DeploymentTaskView } from '@ozz/control-plane/tasks';
import type { DeploymentResponseDto } from './deployment.dto.js';

/** Stored snapshots contain references only; field names expose the public task contract. */
export function presentDeployment(value: DeploymentTaskView): DeploymentResponseDto {
  const { snapshotJson, targetJson, resolvedImageJson, result, failureObservation, ...task } =
    value;
  return {
    ...task,
    initiatorKind: task.initiatorKind === 'webhook' ? 'webhook' : 'admin',
    snapshot: snapshotJson as DeploymentResponseDto['snapshot'],
    target: targetJson as DeploymentResponseDto['target'],
    resolvedImage: resolvedImageJson as DeploymentResponseDto['resolvedImage'],
    result: result as DeploymentResponseDto['result'],
    failureObservation: failureObservation as DeploymentResponseDto['failureObservation'],
  };
}
