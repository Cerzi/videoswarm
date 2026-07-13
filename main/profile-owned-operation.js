function runProfileOwnedOperation({
  captureContext,
  assertContextActive,
  operation,
  getFallbackProfileId = () => null,
  getFallbackGeneration = () => null,
  defaultErrorCode = 'PROFILE_OPERATION_ERROR',
}) {
  let context = null;
  try {
    context = captureContext();
    assertContextActive(context);
    const result = operation(context.metadataStore, context);
    assertContextActive(context);
    return {
      success: true,
      profileId: context.profileId,
      generation: context.generation,
      ...(result || {}),
    };
  } catch (error) {
    return {
      success: false,
      profileId: context?.profileId || getFallbackProfileId(),
      generation: context?.generation ?? getFallbackGeneration(),
      error: error?.message || String(error),
      code: error?.code || defaultErrorCode,
    };
  }
}

module.exports = { runProfileOwnedOperation };
