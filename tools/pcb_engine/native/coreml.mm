#import "coreml.hpp"
#import <CoreML/CoreML.h>
#include <cmath>

static NSMutableDictionary<NSString *, NSDictionary *> *models;

static NSDictionary *failure(NSString *message) {
    return @{@"ok": @NO, @"error": message ?: @"Core ML operation failed"};
}

static NSUInteger boundedCount(MLFeatureDescription *description, NSUInteger limit) {
    if (description.type != MLFeatureTypeMultiArray) return 0;
    NSArray *shape = description.multiArrayConstraint.shape;
    if (!shape.count) return 0;
    NSUInteger count = 1;
    for (NSNumber *dimension in shape) {
        if (dimension.integerValue <= 0 || dimension.unsignedIntegerValue > limit / count) return 0;
        count *= dimension.unsignedIntegerValue;
    }
    return count;
}

API_AVAILABLE(macos(14.4))
static void collect(MLModelStructureProgramBlock *block, MLComputePlan *plan,
                    NSMutableArray *operations) {
    for (MLModelStructureProgramOperation *op in block.operations) {
        MLComputePlanDeviceUsage *usage = [plan computeDeviceUsageForMLProgramOperation:op];
        NSMutableArray *supported = [NSMutableArray array];
        for (id device in usage.supportedComputeDevices)
            [supported addObject:NSStringFromClass([device class])];
        [operations addObject:@{@"operation": op.operatorName,
                               @"preferred": usage ? NSStringFromClass([usage.preferredComputeDevice class]) : @"unknown",
                               @"supported": supported}];
        for (MLModelStructureProgramBlock *nested in op.blocks) collect(nested, plan, operations);
    }
}

NSDictionary *pcb_coreml_request(NSDictionary *request) {
    @try {
        if (!models) models = [NSMutableDictionary dictionary];
        NSString *op = request[@"op"];
        if ([op isEqual:@"coreml.capabilities"]) {
            return @{@"ok": @YES, @"result": @{
                @"compute_units": @[@"cpuOnly", @"cpuAndGPU", @"cpuAndNeuralEngine", @"all"],
                @"measured_placement": @"unknown",
                @"note": @"Allowed compute units and anticipated plans do not prove runtime device dispatch."}};
        }
        if ([op isEqual:@"coreml.load"]) {
            if (models.count >= 2) return failure(@"model cache full; unload an unused model first");
            NSString *path = request[@"model_path"];
            if (![path isKindOfClass:NSString.class]) return failure(@"model_path is required");
            NSURL *sourceURL = [NSURL fileURLWithPath:path];
            unsigned long long sourceBytes = 0;
            BOOL directory = NO;
            if (![[NSFileManager defaultManager] fileExistsAtPath:path isDirectory:&directory])
                return failure(@"model source does not exist");
            if (directory) {
                NSDirectoryEnumerator *enumerator = [[NSFileManager defaultManager] enumeratorAtURL:sourceURL
                    includingPropertiesForKeys:@[NSURLFileSizeKey, NSURLIsRegularFileKey] options:0 errorHandler:nil];
                for (NSURL *file in enumerator) {
                    NSNumber *regular = nil, *size = nil;
                    [file getResourceValue:&regular forKey:NSURLIsRegularFileKey error:nil];
                    [file getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
                    if (regular.boolValue) sourceBytes += size.unsignedLongLongValue;
                }
            } else {
                sourceBytes = [[[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil][NSFileSize] unsignedLongLongValue];
            }
            if (sourceBytes > 16 * 1024 * 1024) return failure(@"model exceeds 16 MiB small-ranker admission limit");
            NSString *units = request[@"compute_units"] ?: @"cpuOnly";
            MLModelConfiguration *configuration = [MLModelConfiguration new];
            if ([units isEqual:@"cpuOnly"]) configuration.computeUnits = MLComputeUnitsCPUOnly;
            else if ([units isEqual:@"cpuAndGPU"]) configuration.computeUnits = MLComputeUnitsCPUAndGPU;
            else if ([units isEqual:@"all"]) configuration.computeUnits = MLComputeUnitsAll;
            else if ([units isEqual:@"cpuAndNeuralEngine"]) {
                if (@available(macOS 13.0, *)) configuration.computeUnits = MLComputeUnitsCPUAndNeuralEngine;
                else return failure(@"CPU/Neural Engine requires macOS 13");
            } else return failure(@"unknown compute_units");
            NSError *error = nil;
            NSURL *url = [NSURL fileURLWithPath:path];
            if (![path.pathExtension isEqual:@"mlmodelc"])
                url = [MLModel compileModelAtURL:url error:&error];
            if (!url) return failure(error.localizedDescription);
            MLModel *model = [MLModel modelWithContentsOfURL:url configuration:configuration error:&error];
            if (!model) return failure(error.localizedDescription);
            NSDictionary *inputDescriptions = model.modelDescription.inputDescriptionsByName;
            NSDictionary *outputDescriptions = model.modelDescription.outputDescriptionsByName;
            if (inputDescriptions.count != 1 || !inputDescriptions[@"features"]
                    || !boundedCount(inputDescriptions[@"features"], 65536)
                    || outputDescriptions.count != 1
                    || boundedCount(outputDescriptions.allValues.firstObject, 1) != 1) {
                if (![path.pathExtension isEqual:@"mlmodelc"])
                    [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
                return failure(@"only one fixed numeric feature input and one scalar array output are admitted");
            }
            NSString *identity = NSUUID.UUID.UUIDString;
            models[identity] = @{@"model": model, @"url": url, @"configuration": configuration, @"units": units,
                                @"temporary": @(![path.pathExtension isEqual:@"mlmodelc"])};
            return @{@"ok": @YES, @"result": @{@"model_id": identity, @"requested_compute_units": units,
                @"inputs": model.modelDescription.inputDescriptionsByName.allKeys,
                @"outputs": model.modelDescription.outputDescriptionsByName.allKeys,
                @"source_bytes": @(sourceBytes), @"memory_estimate_bytes": @(sourceBytes * 8),
                @"measured_placement": @"unknown"}};
        }
        NSString *identity = request[@"model_id"];
        NSDictionary *entry = identity ? models[identity] : nil;
        if (!entry) return failure(@"unknown model_id; load a frozen model first");
        MLModel *model = entry[@"model"];
        if ([op isEqual:@"coreml.profile"]) {
            if (@available(macOS 14.4, *)) {
                __block MLComputePlan *plan = nil;
                __block NSError *error = nil;
                dispatch_semaphore_t done = dispatch_semaphore_create(0);
                [MLComputePlan loadContentsOfURL:entry[@"url"] configuration:entry[@"configuration"]
                    completionHandler:^(MLComputePlan *p, NSError *e) {
                        plan = p; error = e; dispatch_semaphore_signal(done);
                    }];
                if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC)) != 0)
                    return failure(@"compute plan timed out");
                if (!plan) return failure(error.localizedDescription);
                NSMutableArray *operations = [NSMutableArray array];
                for (MLModelStructureProgramFunction *function in plan.modelStructure.program.functions.allValues)
                    collect(function.block, plan, operations);
                return @{@"ok": @YES, @"result": @{@"anticipated_operations": operations,
                    @"requested_compute_units": entry[@"units"], @"measured_placement": @"unknown",
                    @"measurement_required": @"Capture Core ML runtime device execution with Instruments."}};
            }
            return failure(@"compute plan requires macOS 14.4");
        }
        if ([op isEqual:@"coreml.predict"]) {
            NSDictionary *inputs = request[@"inputs"];
            if (![inputs isKindOfClass:NSDictionary.class]) return failure(@"inputs dictionary required");
            if (![NSSet setWithArray:inputs.allKeys].count ||
                ![[NSSet setWithArray:inputs.allKeys] isEqual:[NSSet setWithArray:model.modelDescription.inputDescriptionsByName.allKeys]])
                return failure(@"input names must match model exactly");
            NSMutableDictionary *values = [NSMutableDictionary dictionary];
            NSError *error = nil;
            for (NSString *name in inputs) {
                MLFeatureDescription *description = model.modelDescription.inputDescriptionsByName[name];
                if (description.type != MLFeatureTypeMultiArray) return failure(@"only fixed numeric array inputs are supported");
                NSArray *numbers = inputs[name];
                if (![numbers isKindOfClass:NSArray.class]) return failure(@"input must be a flat numeric array");
                NSUInteger count = 1;
                for (NSNumber *dimension in description.multiArrayConstraint.shape) {
                    if (dimension.integerValue <= 0 || dimension.unsignedIntegerValue > 65536 / count)
                        return failure(@"input shape exceeds small-ranker allocation limit");
                    count *= dimension.unsignedIntegerValue;
                }
                if (numbers.count != count) return failure(@"input length differs from model shape");
                MLMultiArray *array = [[MLMultiArray alloc] initWithShape:description.multiArrayConstraint.shape
                    dataType:description.multiArrayConstraint.dataType error:&error];
                if (!array) return failure(error.localizedDescription);
                if (numbers.count != (NSUInteger)array.count) return failure(@"input length differs from model shape");
                for (NSUInteger i = 0; i < numbers.count; i++) {
                    id value = numbers[i];
                    if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()
                        || !std::isfinite([value doubleValue])) return failure(@"input must contain finite numbers");
                    array[i] = value;
                }
                values[name] = [MLFeatureValue featureValueWithMultiArray:array];
            }
            MLDictionaryFeatureProvider *provider = [[MLDictionaryFeatureProvider alloc] initWithDictionary:values error:&error];
            if (!provider) return failure(error.localizedDescription);
            CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
            id<MLFeatureProvider> output = [model predictionFromFeatures:provider error:&error];
            double elapsed = CFAbsoluteTimeGetCurrent() - started;
            if (!output) return failure(error.localizedDescription);
            NSMutableDictionary *result = [NSMutableDictionary dictionary];
            for (NSString *name in output.featureNames) {
                MLFeatureValue *value = [output featureValueForName:name];
                if (value.type != MLFeatureTypeMultiArray) return failure(@"unsupported output type");
                if (value.multiArrayValue.count != 1) return failure(@"output exceeds admitted scalar ranker shape");
                NSMutableArray *numbers = [NSMutableArray array];
                for (NSInteger i = 0; i < value.multiArrayValue.count; i++) {
                    NSNumber *number = value.multiArrayValue[i];
                    if (!std::isfinite(number.doubleValue)) return failure(@"nonfinite model output");
                    [numbers addObject:number];
                }
                result[name] = numbers;
            }
            return @{@"ok": @YES, @"result": @{@"outputs": result}, @"metrics": @{
                @"backend": @"coreml", @"actual_device": @"unknown",
                @"requested_compute_units": entry[@"units"], @"measured_placement": @"unknown",
                @"prediction_s": @(elapsed)}};
        }
        if ([op isEqual:@"coreml.unload"]) {
            [models removeObjectForKey:identity];
            if ([entry[@"temporary"] boolValue])
                [[NSFileManager defaultManager] removeItemAtURL:entry[@"url"] error:nil];
            return @{@"ok": @YES, @"result": @{@"unloaded": identity}};
        }
        return failure(@"unknown coreml operation");
    } @catch (NSException *exception) {
        return failure(exception.reason);
    }
}
