import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize client
const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async ({ req, res, log, error }) => {
    try {
        log('Starting AI career matching...');
        
        const { talentId, surveyResponses } = JSON.parse(req.body);

        if (!talentId || !surveyResponses) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters: talentId and surveyResponses' 
            }, 400);
        }

        log(`Processing career matching for talent: ${talentId}`);

        // Fetch all available career paths
        const careerPathsQuery = await databases.listDocuments(
            'career4me',
            'careerPaths',
            [Query.limit(100)]
        );

        if (careerPathsQuery.documents.length === 0) {
            return res.json({ success: false, error: 'No career paths available' }, 404);
        }

        // Fetch talent details
        const talentQuery = await databases.listDocuments(
            'career4me',
            'talents',
            [Query.equal('talentId', talentId)]
        );

        if (talentQuery.documents.length === 0) {
            return res.json({ success: false, error: 'Talent not found' }, 404);
        }

        const talent = talentQuery.documents[0];

        // Update talent document with survey responses
        await databases.updateDocument(
            'career4me',
            'talents',
            talent.$id,
            {
                ...surveyResponses,
                testTaken: true
            }
        );

        // Get current career path details if available
        let currentCareerPath = null;
        if (surveyResponses.currentPath) {
            try {
                currentCareerPath = await databases.getDocument(
                    'career4me',
                    'careerPaths',
                    surveyResponses.currentPath
                );
            } catch (err) {
                log(`Warning: Could not fetch current career path: ${surveyResponses.currentPath}`);
            }
        }

        // Generate AI-powered career matches
        const matches = await generateAICareerMatches(
            talent,
            surveyResponses,
            careerPathsQuery.documents,
            currentCareerPath,
            log
        );

        log('Career matching completed successfully');
        return res.json({
            success: true,
            matches: matches,
            totalPaths: careerPathsQuery.documents.length,
            matchedPaths: matches.length
        });

    } catch (err) {
        error('Career matching failed:', err);
        return res.json({ 
            success: false, 
            error: err.message || 'Failed to generate career matches',
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        }, 500);
    }
};

async function generateAICareerMatches(talent, surveyResponses, careerPaths, currentCareerPath, log) {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Build comprehensive context for AI analysis
    const contextPrompt = buildContextPrompt(talent, surveyResponses, currentCareerPath);
    
    // Create simplified career paths summary for AI (to reduce token usage)
    const careerPathsSummary = careerPaths.map(path => ({
        id: path.$id,
        title: path.title,
        industry: path.industry,
        requiredSkills: (path.requiredSkills || []).slice(0, 8), // Limit to top skills
        requiredInterests: path.requiredInterests || [],
        suggestedDegrees: path.suggestedDegrees || [],
        description: path.description ? path.description.substring(0, 200) + '...' : '', // Truncate description
        minSalary: path.minSalary || 0,
        maxSalary: path.maxSalary || 0,
        required_background: path.required_background || '',
        time_to_complete: path.time_to_complete || ''
    }));

    const analysisPrompt = `${contextPrompt}

AVAILABLE CAREER PATHS (${careerPathsSummary.length} paths):
${JSON.stringify(careerPathsSummary, null, 1)}

MATCHING CRITERIA:
- Pathfinder: Focus on learning potential, entry requirements, growth opportunities, work environment fit
- Trailblazer: Focus on career advancement, skill building, leadership opportunities, goal alignment
- Horizon Changer: Focus on transferable skills, transition feasibility, motivation for change, environment preferences

ANALYSIS REQUIREMENTS:
1. Analyze user profile against each career path efficiently
2. Calculate match score (0-100) based on:
   - Education alignment (20%)
   - Skills match (30%)
   - Interest alignment (25%)
   - Work environment fit (15%)
   - Career stage specific factors (10%)

3. Provide top 5 matches with:
   - Match score
   - Brief reasoning (2-3 sentences max, speaking directly to user)
   - Top 3 strengths for this path
   - Top 2 development areas
   - Top 3 actionable recommendations

4. Use "you/your" language. Keep responses concise.

Return ONLY valid JSON:
{
  "matches": [
    {
      "careerPathId": "path_id",
      "matchScore": 85,
      "reasoning": "Your skills in X and interest in Y make this a strong match...",
      "strengths": ["You have strong X skills", "Your Y experience", "Your Z interest"],
      "developmentAreas": ["Develop X skills", "Gain Y experience"],
      "recommendations": ["Take X course", "Build Y project", "Network in Z field"]
    }
  ]
}`;

    try {
        log('Generating AI analysis...');
        const result = await model.generateContent(analysisPrompt);
        const aiResponse = result.response.text();
        
        // Extract JSON from AI response
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('AI response does not contain valid JSON');
        }
        
        const analysisResult = JSON.parse(jsonMatch[0]);
        
        // Enrich matches with full career path data
        const enrichedMatches = analysisResult.matches.map(match => {
            const careerPath = careerPaths.find(path => path.$id === match.careerPathId);
            return {
                careerPath: careerPath,
                matchScore: match.matchScore,
                reasoning: match.reasoning,
                strengths: match.strengths,
                developmentAreas: match.developmentAreas,
                recommendations: match.recommendations
            };
        }).filter(match => match.careerPath);

        // Sort by match score descending
        enrichedMatches.sort((a, b) => b.matchScore - a.matchScore);
        
        log(`Generated ${enrichedMatches.length} career matches`);
        return enrichedMatches.slice(0, 5); // Ensure max 5 results

    } catch (err) {
        log('AI analysis failed, falling back to rule-based matching');
        
        // Fallback to simpler rule-based matching
        return generateFallbackMatches(surveyResponses, careerPaths, talent.careerStage);
    }
}

function buildContextPrompt(talent, surveyResponses, currentCareerPath) {
    const careerStageDescriptions = {
        'Pathfinder': 'Finding their feet in career life, looking for career direction and learning opportunities',
        'Trailblazer': 'Established professional looking to continue growth in their career',
        'Horizon Changer': 'Professional looking to pivot to a different career path'
    };

    let prompt = `USER PROFILE - ${talent.careerStage}:
- Stage: ${talent.careerStage} (${careerStageDescriptions[talent.careerStage]})
- Age: ${calculateAge(talent.dateofBirth)}
- Education Level: ${surveyResponses.educationLevel || 'Not specified'}`;

    if (surveyResponses.degreeProgram) {
        prompt += `\n- Degree Program: ${surveyResponses.degreeProgram}`;
    }

    prompt += `\n- Current Skills: ${(surveyResponses.currentSkills || []).join(', ')}
- Skills to Learn: ${(surveyResponses.skillsToLearn || []).join(', ')}
- Interests: ${(surveyResponses.interests || []).join(', ')}
- Interested Fields: ${(surveyResponses.interestedFields || []).join(', ')}`;

    if (surveyResponses.workEnvironmentPreference) {
        prompt += `\n- Work Environment Preference: ${surveyResponses.workEnvironmentPreference}`;
    }

    if (surveyResponses.currentWorkEnvironment) {
        prompt += `\n- Current Work Environment: ${surveyResponses.currentWorkEnvironment}`;
    }

    if (currentCareerPath) {
        prompt += `\n- Current Career Path: ${currentCareerPath.title} (${currentCareerPath.industry})
- Experience: ${surveyResponses.yearsExperience || 'Not specified'} years
- Seniority: ${surveyResponses.currentSeniorityLevel || 'Not specified'}`;
    }

    if (surveyResponses.careerGoals) {
        prompt += `\n- Career Goals: ${surveyResponses.careerGoals}`;
    }

    if (surveyResponses.reasonForChange) {
        prompt += `\n- Reason for Change: ${surveyResponses.reasonForChange}
- Change Urgency: ${surveyResponses.changeUrgency || 'Not specified'}`;
    }

    return prompt;
}

function calculateAge(dateOfBirth) {
    if (!dateOfBirth) return 'Not specified';
    
    const birth = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
        age--;
    }
    
    return age;
}

function generateFallbackMatches(surveyResponses, careerPaths, careerStage) {
    // Simple rule-based matching as fallback
    const matches = careerPaths.map(path => {
        let score = 0;
        
        // Skills matching
        const currentSkills = surveyResponses.currentSkills || [];
        const skillMatches = (path.requiredSkills || []).filter(skill => 
            currentSkills.includes(skill)
        ).length;
        score += skillMatches * 15;
        
        // Interest matching  
        const interests = surveyResponses.interests || [];
        const interestMatches = (path.requiredInterests || []).filter(interest => 
            interests.includes(interest)
        ).length;
        score += interestMatches * 20;
        
        // Field matching
        const interestedFields = surveyResponses.interestedFields || [];
        if (interestedFields.includes(path.industry)) {
            score += 25;
        }
        
        // Education matching
        if (surveyResponses.degreeProgram) {
            const hasRequiredEducation = (path.suggestedDegrees || []).includes(surveyResponses.degreeProgram);
            if (hasRequiredEducation) {
                score += 20;
            }
        }
        
        // Career stage specific adjustments
        if (careerStage === 'Pathfinder' && path.required_background === 'Entry Level') {
            score += 15;
        }
        
        const skillsCount = currentSkills.length;
        const interestsCount = interests.length;
        
        return {
            careerPath: path,
            matchScore: Math.min(score, 100),
            reasoning: `Your profile shows ${skillMatches} relevant skills and ${interestMatches} matching interests with this career path.`,
            strengths: currentSkills.slice(0, 3).map(skill => `You have ${skill} skills`),
            developmentAreas: ['Develop specialized skills', 'Gain industry experience'],
            recommendations: ['Take relevant courses', 'Build portfolio projects', 'Network with professionals']
        };
    });
    
    // Return top 5 matches
    return matches
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 5);
}