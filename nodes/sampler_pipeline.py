#import os
#import sys
#
## Ensure Impact Pack's "modules" folder is importable (sibling custom node folder)
#_this_dir = os.path.dirname(__file__)
#_custom_root = os.path.abspath(os.path.join(_this_dir, ".."))
#_workspace_custom_nodes = os.path.abspath(os.path.join(_custom_root, ".."))
#_impact_modules = os.path.join(_workspace_custom_nodes, "ComfyUI-Impact-Pack", "modules")
#if _impact_modules not in sys.path:
#	sys.path.append(_impact_modules)
#
#from impact.impact_pack import DetailerForEach
#import comfy
#
#
#class SamplerPipelineNode:
#    @classmethod
#    def INPUT_TYPES(cls):
#        return {
#            "required": {
#                "pipeline_packs": ("REGEX_PACK",),
#                "model": ("MODEL",),
#                "positive": ("CONDITIONING",),
#                "negative": ("CONDITIONING",),
#                "latent_image": ("LATENT",),
#                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
#                "steps": ("INT", {"default": 20, "min": 1, "max": 10000}),
#                "cfg": ("FLOAT", {"default": 8.0, "min": 0.0, "max": 100.0}),
#                "sampler_name": (comfy.samplers.KSampler.SAMPLERS,),
#                "scheduler": (comfy.samplers.KSampler.SCHEDULERS,),
#                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
#            }
#        }
#
#    INPUT_IS_LIST = True
#    RETURN_TYPES = ("LATENT",)
#    RETURN_NAMES = ("samples",)
#    FUNCTION = "execute"
#    CATEGORY = "Kolid-Toolkit"
#
#    def execute(self, pipeline_packs, model, positive, negative, latent_image, seed, steps, cfg, sampler_name, scheduler, denoise=1.0):
#        model = model[0]
#        positive = positive[0]
#        negative = negative[0]
#        latent_image = latent_image[0]
#        seed = seed[0]
#        steps = steps[0]
#        cfg = cfg[0]
#        sampler_name = sampler_name[0]
#        scheduler = scheduler[0]
#        denoise = denoise[0]
#        
#        for pack in pipeline_packs:
#            # Apply pipeline pack logic here
#            title = pack["title"]
#            if title == "Sampler":
#                # Prepare noise
#                latent_samples = latent_image["samples"]
#                batch_inds = latent_image.get("batch_index", None)
#                disable_noise = False
#                noise = None
#                if not disable_noise:
#                    noise = comfy.sample.prepare_noise(latent_samples, seed, batch_inds)
#
#                noise_mask = latent_image.get("noise_mask", None)
#
#                samples = comfy.sample.sample(model, noise, steps, cfg, sampler_name, scheduler, positive, negative,
#                                            latent_samples, denoise=denoise, disable_noise=disable_noise,
#                                            noise_mask=noise_mask, seed=seed)
#                
#                out_latent = latent_image.copy()
#                out_latent["samples"] = samples
#            elif title == "Detailer":
#                # Apply Detailer logic here
#                DetailerForEach.do_detail
#
#            pass
#
#        
#
#        
#        return (out_latent, )
#        